import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OpenAICompatibleAssistantAdapter,
  buildClaudeProfileArgs,
  buildCodexProfileArgs,
  buildInitialPlanPrompt,
  createAssistantAdapter,
  createHeavyAgentAdapter,
} from '../src/adapters.js';
import { normalizeConfig } from '../src/config.js';
import type { AgentProfileConfig, BridgeAgentInput, AssistantConfig, OrchestratorDecisionInput } from '../src/types.js';

function makeAssistantProfile(overrides: Partial<AgentProfileConfig> = {}): AgentProfileConfig {
  return {
    kind: 'openai-compatible',
    provider: 'example-compatible',
    model: 'example-chat-model',
    baseUrl: 'https://api.example.test/v1',
    apiKeyEnv: 'EXAMPLE_API_KEY',
    ...overrides,
  };
}

function makeAssistantAdapter(profile: AgentProfileConfig = makeAssistantProfile()): OpenAICompatibleAssistantAdapter {
  return new OpenAICompatibleAssistantAdapter(profile, { EXAMPLE_API_KEY: 'test-key' }, 'assistant');
}

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
      assistant: makeAssistantProfile(),
      planner: { kind: 'command', provider: 'codex', command: 'codex' },
      reviewer: { kind: 'command', provider: 'claude', command: 'claude' },
      implementer: { kind: 'command', provider: 'codex', command: 'codex' },
      finalReviewer: { kind: 'command', provider: 'claude', command: 'claude' },
    },
    verification: { allowlist: [] },
  };
}

function stubChatContent(content: string): void {
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

describe('OpenAICompatibleAssistantAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes create_task control JSON into a proposal confirmation action', async () => {
    stubChatContent(JSON.stringify({ kind: 'create_task' }));
    const adapter = makeAssistantAdapter();

    const result = await adapter.handleControlChat({
      message: '\u53ef\u4ee5\uff0ccreate task',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    });

    expect(result.kind).toBe('confirm_pending_proposal');
  });

  it('uses Chinese fallback fields for incomplete control-chat proposals', async () => {
    stubChatContent(JSON.stringify({
      kind: 'proposal',
      proposal: {
        title: 'Lark proposal flow',
        task: 'Implement the proposal flow.',
      },
    }));
    const adapter = makeAssistantAdapter();

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
    const adapter = makeAssistantAdapter();

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

  it('parses orchestrator decisions from chat JSON mode', async () => {
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
    const adapter = makeAssistantAdapter();

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
    stubChatContent('not-json');
    const adapter = makeAssistantAdapter();

    const result = await adapter.decideNextAction(makeDecisionInput());

    expect(result.action).toBe('wait_for_user');
    expect(result.confidence).toBe(0);
    expect(result.text).toContain('没有返回有效 JSON');
  });

  it('parses bridge function calls', async () => {
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
    const adapter = makeAssistantAdapter();

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
    const adapter = makeAssistantAdapter();

    await adapter.decideBridgeAction(makeControlBridgeInput());

    const toolNames = (requestBody?.tools as Array<{ function?: { name?: string } }> | undefined)
      ?.map((tool) => tool.function?.name);
    expect(toolNames).toEqual(expect.arrayContaining(['schedule_task_to_project_chat', 'create_project_chat', 'add_project', 'list_projects']));
    expect(toolNames).not.toContain('show_status');
  });

  it('parses bridge assistant text when no tool is called', async () => {
    stubChatContent('我在。');
    const adapter = makeAssistantAdapter();

    const result = await adapter.decideBridgeAction(makeBridgeInput());

    expect(result).toEqual({ kind: 'reply', text: '我在。' });
  });

  it('uses configured OpenAI-compatible provider URL, model, and API key env var', async () => {
    let requestUrl: string | undefined;
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requestUrl = url;
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      authorization = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action: 'wait_for_user', confidence: 1 }) } }],
      }), { status: 200 });
    }));
    const config = makeConfig();
    config.profiles.assistant = makeAssistantProfile({
      provider: 'acme-compatible',
      model: 'acme-chat',
      baseUrl: 'https://llm.acme.test/compatible/v1/',
      apiKeyEnv: 'ACME_CHAT_KEY',
    });

    const adapter = createAssistantAdapter(config, { ACME_CHAT_KEY: 'acme-key' });
    await adapter.decideNextAction({ ...makeDecisionInput(), config });

    expect(requestUrl).toBe('https://llm.acme.test/compatible/v1/chat/completions');
    expect(requestBody?.model).toBe('acme-chat');
    expect(authorization).toBe('Bearer acme-key');
  });

  it('uses legacy DeepSeek profiles only after config compatibility normalization', async () => {
    let requestUrl: string | undefined;
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requestUrl = url;
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      authorization = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action: 'wait_for_user', confidence: 1 }) } }],
      }), { status: 200 });
    }));
    const config = normalizeConfig({
      workflowRoles: { assistant: 'legacy-assistant' },
      profiles: { 'legacy-assistant': { kind: 'deepseek' } },
    });

    const adapter = createAssistantAdapter(config, { DEEPSEEK_API_KEY: 'legacy-key' });
    await adapter.decideNextAction({ ...makeDecisionInput(), config });

    expect(config.profiles['legacy-assistant']).toMatchObject({
      kind: 'openai-compatible',
      provider: 'deepseek',
    });
    expect(requestUrl).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(requestBody?.model).toBe('deepseek-v4-flash');
    expect(authorization).toBe('Bearer legacy-key');
  });

  it('rejects command-backed profiles for assistant chat', async () => {
    const adapter = new OpenAICompatibleAssistantAdapter(
      { kind: 'command', provider: 'codex' },
      {},
      'assistant-api',
    );

    await expect(adapter.handleControlChat({
      message: 'hello',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    })).rejects.toThrow('Assistant profile "assistant-api" is command-backed');
  });

  it('reports a readable missing API key error', async () => {
    const adapter = new OpenAICompatibleAssistantAdapter(
      makeAssistantProfile({ apiKeyEnv: 'MISSING_PROVIDER_KEY' }),
      {},
      'assistant-api',
    );

    await expect(adapter.handleControlChat({
      message: 'hello',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    })).rejects.toThrow('Assistant profile "assistant-api" expects API key env var MISSING_PROVIDER_KEY');
  });

  it('reports a readable missing apiKeyEnv error', async () => {
    const adapter = new OpenAICompatibleAssistantAdapter(
      makeAssistantProfile({ apiKeyEnv: undefined as never }),
      {},
      'assistant-api',
    );

    await expect(adapter.handleControlChat({
      message: 'hello',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    })).rejects.toThrow('Assistant profile "assistant-api" is missing apiKeyEnv');
  });

  it('reports a readable missing command error before spawning a heavy agent', async () => {
    const config = makeConfig();
    config.profiles.planner = { kind: 'command', provider: 'custom-cli' };
    const heavy = createHeavyAgentAdapter(config, true);

    await expect(heavy.createInitialPlan({
      task: 'Plan this.',
      projectContext: '',
      difficulty: 'low',
      state: { taskId: 'TASK-1', requestedChanges: [] } as never,
      config,
    })).rejects.toThrow('Workflow role architect uses profile "planner", but profiles.planner.command is missing.');
  });

});
