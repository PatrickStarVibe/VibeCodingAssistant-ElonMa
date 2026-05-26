import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, AssistantAdapter } from '../src/adapters.js';
import { AssistantConversationService } from '../src/conversation.js';
import type {
  ControlChatResult,
  IntentResult,
  AssistantConfig,
  AssistantRouteResult,
  AssistantTextResult,
  OrchestratorDecision,
  PlanResult,
  TaskProposal,
  WorkflowDifficulty,
} from '../src/types.js';
import { WorkflowService } from '../src/workflow.js';

class FakeAssistant implements AssistantAdapter {
  async decideNextAction(): Promise<OrchestratorDecision> {
    return { action: 'wait_for_user', reason: 'test fallback', confidence: 1 };
  }

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

  async createRevisionInstructions(): Promise<AssistantTextResult> {
    return { markdown: 'instructions', needsUserDecision: false };
  }

  async explainRevisedPlan(): Promise<AssistantTextResult> {
    return { markdown: 'explanation', needsUserDecision: false };
  }

  async answerQuestion(input: { question: string }): Promise<string> {
    return `answer: ${input.question}`;
  }

  async interpretAmbiguousReply(): Promise<string> {
    return 'clarify';
  }

  async handleControlChat(input: { message: string; pendingProposal?: TaskProposal; mode: 'message' | 'edit' }): Promise<ControlChatResult> {
    if (input.mode === 'edit' && input.pendingProposal) return { kind: 'proposal', proposal: input.pendingProposal };
    return { kind: 'answer', markdown: input.message };
  }

  async routeAfterFinalReview(): Promise<AssistantRouteResult> {
    return { route: 'complete', reason: 'ok' };
  }
}

class FakeHeavyAgents implements HeavyAgentAdapter {
  async createInitialPlan(input: { difficulty: WorkflowDifficulty }): Promise<PlanResult> {
    return { markdown: `plan ${input.difficulty}`, verificationCommands: [] };
  }

  async reviewPlan(input: { difficulty: WorkflowDifficulty }): Promise<ReviewResult> {
    return {
      markdown: 'review',
      ...(input.difficulty === 'high' || input.difficulty === 'extra-high'
        ? { reviewerBlockerOutput: { blockers: [], previousVerdicts: [] } }
        : {}),
    };
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

function makeConfig(targetDir: string): AssistantConfig {
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
    },
    maxRevisionRounds: 3,
    workflowRoles: {
      assistant: 'assistant',
      low: { architect: 'planner', planReviewer: 'planner', developer: 'implementer', finalReviewer: 'implementer' },
      medium: { architect: 'planner', planReviewer: 'reviewer', developer: 'implementer', finalReviewer: 'finalReviewer' },
      high: { architect: 'reviewer', planReviewer: 'planner', developer: 'implementer', finalReviewer: 'finalReviewer' },
      'extra-high': { architect: 'reviewer', planReviewer: 'planner', developer: 'implementer', finalReviewer: 'finalReviewer' },
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

async function makeHarness(): Promise<{
  root: string;
  targetDir: string;
  store: ArtifactStore;
  service: WorkflowService;
  conversation: AssistantConversationService;
  config: AssistantConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  const service = new WorkflowService(store, config, assistant, new FakeHeavyAgents(), { executeVerification: false });
  const conversation = new AssistantConversationService(service, store, assistant, config);
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

  it('does not treat approval as a difficulty choice', async () => {
    const harness = await makeHarness();
    try {
      const created = await harness.service.createTask({ title: 'Approve task', task: 'Build it.' });
      await harness.service.planTask(created.state.taskId);

      const turn = await harness.conversation.routeTaskMessage(created.state.taskId, '同意');

      expect(turn.kind).toBe('reply');
      expect((await harness.store.loadState(created.state.taskId)).status).toBe('awaiting_difficulty_selection');
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

});
