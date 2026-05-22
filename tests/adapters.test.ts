import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeepSeekManagerAdapter, buildInitialPlanPrompt } from '../src/adapters.js';
import type { ManagerConfig } from '../src/types.js';

function makeConfig(): ManagerConfig {
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
      watchIntervalSeconds: 1,
    },
    maxRevisionRounds: 3,
    roles: {
      manager: 'manager',
      planner: 'planner',
      reviewer: 'reviewer',
      implementer: 'implementer',
      finalReviewer: 'finalReviewer',
    },
    workflowRoles: {
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
      manager: { kind: 'deepseek' },
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

describe('DeepSeekManagerAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes create_task control JSON into a proposal confirmation action', async () => {
    stubDeepSeekContent(JSON.stringify({ kind: 'create_task' }));
    const adapter = new DeepSeekManagerAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

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
    const adapter = new DeepSeekManagerAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    const result = await adapter.handleControlChat({
      message: 'Implement the proposal flow',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    });

    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    expect(result.proposal.interpretedIntent).toContain('整理成一个可能的 Manager workflow 任务');
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
    const adapter = new DeepSeekManagerAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    await adapter.handleControlChat({
      message: 'Based on this spec, create a task proposal',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    });

    const messages = requestBody?.messages as Array<{ role: string; content: string }> | undefined;
    const system = messages?.[0]?.content ?? '';
    expect(system).toContain('默认使用简体中文回复');
    expect(system).toContain('即使用户消息、prompt 或规格文档是英文');
    expect(system).toContain('不要输出 "Based on your detailed specification"');
  });

  it('keeps workflow directives in the Architect prompt builder', () => {
    const prompt = buildInitialPlanPrompt({
      task: '# Task\n\nOriginal user prompt.',
      projectContext: 'Project context.',
      brief: 'Manager brief.',
      difficulty: 'high',
      state: {
        requestedChanges: ['Use the original user prompt verbatim as the source of truth.'],
      },
    });

    expect(prompt).toContain('User workflow directives and requested changes');
    expect(prompt).toContain('Use the original user prompt verbatim');
    expect(prompt).toContain('follow the user workflow directives');
  });

});
