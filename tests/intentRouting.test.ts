import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, ManagerAdapter } from '../src/adapters.js';
import { ManagerConversationService } from '../src/conversation.js';
import { LarkBridge, type LarkClientPort } from '../src/larkBridge.js';
import { LarkBridgeStateStore } from '../src/larkBridgeState.js';
import type {
  ControlChatResult,
  IntentResult,
  ManagerConfig,
  ManagerRouteResult,
  ManagerTextResult,
  PlanResult,
  TaskChatRouteResult,
  TaskProposal,
  WorkflowDifficulty,
} from '../src/types.js';
import { WorkflowService } from '../src/workflow.js';

class FakeManager implements ManagerAdapter {
  async classifyIntent(input: { userMessage: string; state: { status: string } }): Promise<IntentResult> {
    const text = input.userMessage.trim();
    if (text === 'high') return intent('difficulty', '选择高难度', { difficulty: 'high' });
    if (text === '同意') return intent('approve', '同意继续');
    if (text === '验收通过') return intent('approve', '验收通过');
    if (text === '啥情况了') return intent('status', '查看状态');
    if (text === '行吧') return intent('approve', '可能是同意，但需要确认', { confidence: 0.4, requiresClarification: true });
    if (input.state.status === 'awaiting_user_acceptance' && text.includes('备注')) return intent('note', '记录备注', { note: text });
    return intent('unknown', '不确定', { confidence: 0.2, requiresClarification: true });
  }

  async composeReply(input: { rawMessage: string }): Promise<{ text: string }> {
    return { text: input.rawMessage };
  }

  async createTaskBrief(): Promise<ManagerTextResult> {
    return { markdown: 'brief', needsUserDecision: false };
  }

  async createRevisionInstructions(): Promise<ManagerTextResult> {
    return { markdown: 'instructions', needsUserDecision: false };
  }

  async explainRevisedPlan(): Promise<ManagerTextResult> {
    return { markdown: 'explanation', needsUserDecision: false };
  }

  async answerQuestion(input: { question: string }): Promise<string> {
    return `answer: ${input.question}`;
  }

  async interpretAmbiguousReply(): Promise<string> {
    return 'clarify';
  }

  async routeTaskChat(): Promise<TaskChatRouteResult> {
    return { action: 'clarify', confidence: 0, reason: 'unused' };
  }

  async handleControlChat(input: { message: string; pendingProposal?: TaskProposal; mode: 'message' | 'edit' }): Promise<ControlChatResult> {
    if (input.mode === 'edit' && input.pendingProposal) return { kind: 'proposal', proposal: input.pendingProposal };
    return { kind: 'answer', markdown: input.message };
  }

  async routeAfterFinalReview(): Promise<ManagerRouteResult> {
    return { route: 'complete', reason: 'ok' };
  }
}

class FakeHeavyAgents implements HeavyAgentAdapter {
  async createInitialPlan(input: { difficulty: WorkflowDifficulty }): Promise<PlanResult> {
    return { markdown: `plan ${input.difficulty}`, verificationCommands: [] };
  }

  async reviewPlan(): Promise<{ markdown: string }> {
    return { markdown: 'review' };
  }

  async revisePlan(): Promise<PlanResult> {
    return { markdown: 'revised', verificationCommands: [] };
  }

  async implement(): Promise<{ markdown: string; changedFiles: string[] }> {
    return { markdown: 'implemented', changedFiles: [] };
  }

  async finalReview(): Promise<{ markdown: string; passed: boolean }> {
    return { markdown: 'final', passed: true };
  }
}

class FakeLarkClient implements LarkClientPort {
  sentTexts: { chatId: string; text: string }[] = [];
  sentFiles: { chatId: string; path: string; name: string }[] = [];

  async start(): Promise<void> {}

  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }

  async sendFile(chatId: string, file: { path: string; name: string }): Promise<void> {
    this.sentFiles.push({ chatId, ...file });
  }

  async createTaskChat(): Promise<string> {
    return 'task-chat-1';
  }
}

function intent(
  name: IntentResult['intent'],
  userFacingInterpretation: string,
  extras: Partial<IntentResult> = {},
): IntentResult {
  return {
    intent: name,
    confidence: 0.95,
    requiresClarification: false,
    userFacingInterpretation,
    ...extras,
  };
}

function makeConfig(targetDir: string): ManagerConfig {
  return {
    workspace: { targetDir },
    defaultProjectId: 'default',
    projects: [{
      id: 'default',
      name: 'Default',
      targetDir,
      docsDir: 'project-docs/default',
      alwaysRead: [],
    }],
    artifactsDir: 'logs/ai-workflow',
    lark: {
      platform: 'lark',
      appIdEnv: 'LARK_APP_ID',
      appSecretEnv: 'LARK_APP_SECRET',
      allowedOpenIds: ['user-open-id'],
      taskMemberOpenIds: [],
      controlChatIds: [],
      watchIntervalSeconds: 1,
      pairingCode: '123456',
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
      low: { architect: 'planner', planReviewer: 'planner', developer: 'implementer', finalReviewer: 'implementer' },
      medium: { architect: 'planner', planReviewer: 'reviewer', developer: 'implementer', finalReviewer: 'finalReviewer' },
      high: { architect: 'reviewer', planReviewer: 'reviewer', developer: 'implementer', finalReviewer: 'finalReviewer' },
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

async function makeHarness(): Promise<{
  root: string;
  targetDir: string;
  store: ArtifactStore;
  service: WorkflowService;
  conversation: ManagerConversationService;
  config: ManagerConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), 'manager-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'manager-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const manager = new FakeManager();
  const service = new WorkflowService(store, config, manager, new FakeHeavyAgents(), { executeVerification: false });
  const conversation = new ManagerConversationService(service, store, manager, config);
  return { root, targetDir, store, service, conversation, config };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

async function createAwaitingAcceptance(harness: Awaited<ReturnType<typeof makeHarness>>): Promise<string> {
  const created = await harness.service.createTask({ title: 'Acceptance task', task: 'Ship it.' });
  let state = await harness.store.writeArtifact(created.state, 'implementation-log', 'implemented');
  state = await harness.store.writeArtifact(state, 'test-build-log', 'tests passed');
  state = await harness.store.writeArtifact(state, 'final-review', 'final passed');
  state = {
    ...state,
    status: 'awaiting_user_acceptance',
    pendingUserPrompt: "等你验收：直接说'验收通过'即可生成 task-record。",
    updatedAt: new Date().toISOString(),
  };
  await harness.store.saveState(state);
  return state.taskId;
}

describe('intent routing conversation layer', () => {
  it('strips mentions before classifying a difficulty choice', async () => {
    const harness = await makeHarness();
    try {
      const created = await harness.service.createTask({ title: 'Mention task', task: 'Build it.' });
      await harness.service.planTask(created.state.taskId);
      await harness.service.reply(created.state.taskId, 'approve A');

      const turn = await harness.conversation.routeTaskMessage(created.state.taskId, '@_user_1 high');

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.difficulty).toBe('high');
        expect(result.state.status).toBe('ready_for_decision');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('routes classifier approve through the brief gate', async () => {
    const harness = await makeHarness();
    try {
      const created = await harness.service.createTask({ title: 'Approve task', task: 'Build it.' });
      await harness.service.planTask(created.state.taskId);

      const turn = await harness.conversation.routeTaskMessage(created.state.taskId, '同意');

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.status).toBe('awaiting_difficulty_selection');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('normalizes approve to accept at the user acceptance gate', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createAwaitingAcceptance(harness);

      const turn = await harness.conversation.routeTaskMessage(taskId, '验收通过');

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.status).toBe('completed');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('does not mutate state when classification asks for clarification', async () => {
    const harness = await makeHarness();
    try {
      const created = await harness.service.createTask({ title: 'Clarify task', task: 'Build it.' });

      const turn = await harness.conversation.routeTaskMessage(created.state.taskId, '行吧');

      expect(turn.kind).toBe('reply');
      expect((await harness.store.loadState(created.state.taskId)).status).toBe('created');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('does not mutate state when the classified intent is not allowed', async () => {
    const harness = await makeHarness();
    try {
      const created = await harness.service.createTask({ title: 'Blocked task', task: 'Build it.' });

      const turn = await harness.conversation.routeTaskMessage(created.state.taskId, '同意');

      expect(turn.kind).toBe('reply');
      expect((await harness.store.loadState(created.state.taskId)).status).toBe('created');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('does not resend the same pending notification block', async () => {
    const harness = await makeHarness();
    try {
      const created = await harness.service.createTask({ title: 'Dedupe task', task: 'Build it.' });
      const taskState = {
        ...created.state,
        status: 'awaiting_difficulty_selection' as const,
        pendingUserPrompt: 'Choose low, medium, or high.',
        updatedAt: new Date().toISOString(),
      };
      await harness.store.saveState(taskState);

      const client = new FakeLarkClient();
      const stateStore = new LarkBridgeStateStore(harness.root, harness.config);
      const bridge = new LarkBridge(harness.config, harness.store, client, harness.conversation, stateStore);
      const bridgeState = await stateStore.load();
      bridgeState.bindingsByChatId['task-chat-1'] = {
        taskId: created.state.taskId,
        title: created.state.title,
        createdAt: new Date().toISOString(),
      };
      await stateStore.save(bridgeState);

      await bridge.watchTaskStatuses();
      const sentAfterFirstWatch = client.sentTexts.length;
      await bridge.watchTaskStatuses();

      expect(sentAfterFirstWatch).toBe(1);
      expect(client.sentTexts).toHaveLength(1);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });
});
