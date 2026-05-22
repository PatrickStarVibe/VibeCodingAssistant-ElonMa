import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeepSeekManagerAdapter, taskChatRouteFromContent } from '../src/adapters.js';
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
        planReviewer: 'reviewer',
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

  it('does not leak create_task control JSON as a chat answer', async () => {
    stubDeepSeekContent(JSON.stringify({ kind: 'create_task' }));
    const adapter = new DeepSeekManagerAdapter({ kind: 'deepseek' }, { DEEPSEEK_API_KEY: 'test-key' });

    const result = await adapter.handleControlChat({
      message: '\u53ef\u4ee5\uff0ccreate task',
      mode: 'message',
      projectContext: '',
      config: makeConfig(),
    });

    expect(result.kind).toBe('clarify');
    expect(result.markdown).toContain('Reply `create task`');
    expect(result.markdown).not.toContain('"kind"');
  });

  it('normalizes malformed task chat route JSON into a clarify route', () => {
    const result = taskChatRouteFromContent('not json');

    expect(result.action).toBe('clarify');
    expect(result.confidence).toBe(0);
    expect(result.reason).toContain('not valid JSON');
  });

  it('normalizes invalid task chat actions while preserving safe fields', () => {
    const result = taskChatRouteFromContent(JSON.stringify({
      action: 'launch_missiles',
      confidence: 99,
      reason: 'bad action',
      replyMarkdown: 'please clarify',
      actionArgs: {
        difficulty: 'medium',
        artifact: 'revised-plan',
      },
    }));

    expect(result.action).toBe('clarify');
    expect(result.confidence).toBe(1);
    expect(result.replyMarkdown).toBe('please clarify');
    expect(result.actionArgs).toEqual({ difficulty: 'medium', artifact: 'revised-plan' });
  });
});
