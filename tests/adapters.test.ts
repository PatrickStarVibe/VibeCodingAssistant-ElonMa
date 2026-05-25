import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DeepSeekAssistantAdapter,
  buildClaudeProfileArgs,
  buildCodexProfileArgs,
  buildInitialPlanPrompt,
} from '../src/adapters.js';
import type { BridgeAgentInput, AssistantConfig, OrchestratorDecisionInput } from '../src/types.js';

function makeConfig(): AssistantConfig {
  return {
    workspace: { targetDir: 'target-workspace' },
    artifactsDir: 'logs/ai-workflow',
    lark: {
      platform: 'lark',
      appIdEnv: 'LARK_APP_ID',
      appSecretEnv: 'LARK_APP_SECRET',
      allowedOpenIds: [],
      taskMemberOpenIds: [],
      controlChatIds: [],
    },
    maxRevisionRounds: 3,
    workflowRoles: {
      assistant: 'assistant',
      low: {
        architect: 'planner',
        planReviewer: 'planner',
        developer: 'implementer',
        finalReviewer: 'implementer',
      },
      medium: {
        architect: 'planner',
        planReviewer: 'reviewer',
        developer: 'implementer',
        finalReviewer: 'finalReviewer',
      },
      high: {
        architect: 'reviewer',
        planReviewer: 'planner',
        developer: 'implementer',
        finalReviewer: 'finalReviewer',
      },
    },
    profiles: {
      assistant: { kind: 'deepseek' },
      planner: { kind: 'codex' },
      reviewer: { kind: 'claude' },
      implementer: { kind: 'codex' },
      finalReviewer: { kind: 'claude' },
    },
    verification: { allowlist: [] },
  };
}

function stubDeepSeekContent(content: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status: 200 })));
}

function makeDecisionInput(): OrchestratorDecisionInput {
  return {
    state: {
      taskId: 'TASK-1',
      title: 'Small task',
      status: 'awaiting_difficulty_selection',
      revisionRound: 0,
      reviewerRunCount: 0,
    },
    allowedActions: [
      { id: 'difficulty', description: 'Choose the workflow difficulty.' },
      { id: 'ask', description: 'Ask a question.' },
    ],
    requestedChanges: [],
    recentDecisionLog: '',
    latestUserMessage: 'low',
    config: makeConfig(),
  };
}

function makeBridgeInput(): BridgeAgentInput {
  return {
    latestUserMessage: 'low',
    chat: {
      chatId: 'chat-1',
      senderOpenId: 'user-open-id',
      chatKind: 'project',
      projectChat: { projectId: 'default', hasActiveTask: true },
      boundTaskId: 'TASK-1',
      canCreateTask: true,
    },
    task: {
      taskId: 'TASK-1',
      title: 'Small task',
      status: 'awaiting_difficulty_selection',
      revisionRound: 0,
      reviewerRunCount: 0,
      requestedChanges: [],
    },
    projects: [{ id: 'default', name: 'Default' }],
    config: makeConfig(),
  };
}

function makeControlBridgeInput(): BridgeAgentInput {
  return {
    latestUserMessage: 'Create a task for Default.',
    chat: {
      chatId: 'control-chat',
      senderOpenId: 'user-open-id',
      chatKind: 'control',
      canCreateTask: true,
    },
    projectChatsSummary: [{ chatId: 'project-chat-1', projectId: 'default', idle: true, name: 'Assistant - [Default] #1' }],
    projects: [{ id: 'default', name: 'Default' }],
    config: makeConfig(),
  };
}

describe('DeepSeekAssistantAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes create_task control JSON into a proposal confirmation action', async () => {
    stubDeepSeekContent(JSON.stringify({ kind: 'create_task' }));
    const adapter = new DeepSeekAssistantAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    const result = await adapter.handleControlChat({
      message: '\u53ef\u4ee5\uff0ccreate task',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    });

    expect(result.kind).toBe('confirm_pending_proposal');
  });

  it('uses Chinese fallback fields for incomplete control-chat proposals', async () => {
    stubDeepSeekContent(JSON.stringify({
      kind: 'proposal',
      proposal: {
        title: 'Lark proposal flow',
        task: 'Implement the proposal flow.',
      },
    }));
    const adapter = new DeepSeekAssistantAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    const result = await adapter.handleControlChat({
      message: 'Implement the proposal flow',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    });

    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    expect(result.proposal.interpretedIntent).toContain('整理成一个可能的 assistant workflow 任务');
    expect(result.proposal.wouldDo.join('\n')).toContain('在你确认后');
    expect(result.proposal.wouldNotDo.join('\n')).toContain('不会在你确认前');
    expect(result.proposal.suggestedNextAction).toContain('创建任务');
  });

  it('instructs control chat to keep user-facing output Chinese even for English prompts', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ kind: 'answer', markdown: '好的。' }) } }],
      }), { status: 200 });
    }));
    const adapter = new DeepSeekAssistantAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    await adapter.handleControlChat({
      message: 'Based on this spec, create a task proposal',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    });

    const messages = requestBody?.messages as Array<{ role: string; content: string }> | undefined;
    const system = messages?.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n') ?? '';
    expect(system).toContain('personal AI work assistant and coordinator');
    expect(system).toContain('not a state-machine narrator');
    expect(system).toContain('默认使用简体中文回复');
    expect(system).toContain('即使用户消息、prompt 或规格文档是英文');
    expect(system).toContain('不要输出 "Based on your detailed specification"');
  });

  it('keeps workflow directives in the Architect prompt builder', () => {
    const prompt = buildInitialPlanPrompt({
      task: '# Task\n\nOriginal user prompt.',
      projectContext: 'Project context.',
      difficulty: 'high',
      state: {
        requestedChanges: ['Use the original user prompt verbatim as the source of truth.'],
      },
    });

    expect(prompt).toContain('User workflow directives and requested changes');
    expect(prompt).toContain('Use the original user prompt verbatim');
    expect(prompt).toContain('follow the user workflow directives');
  });

  it('builds Codex CLI args from profile model and effort', () => {
    expect(buildCodexProfileArgs({
      kind: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
    })).toEqual(['--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"']);
  });

  it('builds Claude CLI args from profile model and effort', () => {
    expect(buildClaudeProfileArgs({
      kind: 'claude',
      model: 'claude-opus-4-7',
      effort: 'high',
    })).toEqual(['--model', 'claude-opus-4-7', '--effort', 'high']);
  });

  it('parses orchestrator decisions from DeepSeek JSON mode', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              action: 'forward_to_workflow',
              intent: 'difficulty',
              difficulty: 'low',
              instruction: 'Keep the scope tight.',
              reasoning: 'The user chose a low difficulty workflow.',
              confidence: 0.91,
            }),
          },
        }],
      }), { status: 200 });
    }));
    const adapter = new DeepSeekAssistantAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    const result = await adapter.decideNextAction(makeDecisionInput());

    expect(requestBody?.response_format).toEqual({ type: 'json_object' });
    expect(result).toMatchObject({
      action: 'forward_to_workflow',
      intent: 'difficulty',
      difficulty: 'low',
      instruction: 'Keep the scope tight.',
      confidence: 0.91,
    });
  });

  it('falls back safely when orchestrator decision JSON is invalid', async () => {
    stubDeepSeekContent('not-json');
    const adapter = new DeepSeekAssistantAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    const result = await adapter.decideNextAction(makeDecisionInput());

    expect(result.action).toBe('wait_for_user');
    expect(result.confidence).toBe(0);
    expect(result.text).toContain('没有返回有效 JSON');
  });

  it('parses DeepSeek bridge function calls', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              type: 'function',
              function: {
                name: 'choose_difficulty',
                arguments: JSON.stringify({ difficulty: 'low', instruction: 'Use original prompt.' }),
              },
            }],
          },
        }],
      }), { status: 200 });
    }));
    const adapter = new DeepSeekAssistantAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    const result = await adapter.decideBridgeAction(makeBridgeInput());

    expect(requestBody?.tools).toEqual(expect.any(Array));
    const toolNames = (requestBody?.tools as Array<{ function?: { name?: string } }> | undefined)
      ?.map((tool) => tool.function?.name);
    expect(toolNames).toEqual(expect.arrayContaining(['choose_difficulty', 'show_status', 'list_projects']));
    expect(toolNames).not.toContain('add_project');
    expect(result).toEqual({
      kind: 'tool_call',
      toolCall: {
        name: 'choose_difficulty',
        arguments: { difficulty: 'low', instruction: 'Use original prompt.' },
      },
    });
  });

  it('gates bridge tools by chat kind', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200 });
    }));
    const adapter = new DeepSeekAssistantAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    await adapter.decideBridgeAction(makeControlBridgeInput());

    const toolNames = (requestBody?.tools as Array<{ function?: { name?: string } }> | undefined)
      ?.map((tool) => tool.function?.name);
    expect(toolNames).toEqual(expect.arrayContaining(['schedule_task_to_project_chat', 'create_project_chat', 'add_project', 'list_projects']));
    expect(toolNames).not.toContain('show_status');
  });

  it('parses DeepSeek bridge assistant text when no tool is called', async () => {
    stubDeepSeekContent('我在。');
    const adapter = new DeepSeekAssistantAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    const result = await adapter.decideBridgeAction(makeBridgeInput());

    expect(result).toEqual({ kind: 'reply', text: '我在。' });
  });

});
