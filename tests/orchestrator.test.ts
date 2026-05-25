import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, AssistantAdapter } from '../src/adapters.js';
import { orchestrateTaskMessage } from '../src/orchestrator.js';
import type {
  ControlChatResult,
  FinalReviewResult,
  ImplementationResult,
  IntentResult,
  AssistantConfig,
  AssistantRouteResult,
  AssistantTextResult,
  OrchestratorDecision,
  OrchestratorDecisionInput,
  PlanResult,
  ReviewResult,
  TaskProposal,
  WorkflowDifficulty,
} from '../src/types.js';
import { WorkflowService } from '../src/workflow.js';

const execFileAsync = promisify(execFile);

class FakeAssistant implements AssistantAdapter {
  decisions: OrchestratorDecision[] = [];
  decisionInputs: OrchestratorDecisionInput[] = [];

  async decideNextAction(input: OrchestratorDecisionInput): Promise<OrchestratorDecision> {
    this.decisionInputs.push(input);
    return this.decisions.shift() ?? { action: 'wait_for_user', reason: 'test fallback', confidence: 1 };
  }

  async classifyIntent(): Promise<IntentResult> {
    return { intent: 'unknown', confidence: 0.2, requiresClarification: true, userFacingInterpretation: 'unknown' };
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

  async reviewPlan(): Promise<ReviewResult> {
    return { markdown: 'review' };
  }

  async revisePlan(): Promise<PlanResult> {
    return { markdown: 'revised', verificationCommands: [] };
  }

  async implement(): Promise<ImplementationResult> {
    return { markdown: 'implemented', changedFiles: [] };
  }

  async finalReview(): Promise<FinalReviewResult> {
    return { markdown: 'final review passed', passed: true };
  }
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
      allowedOpenIds: [],
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
  assistant: FakeAssistant;
  workflow: WorkflowService;
  config: AssistantConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
  await execFileAsync('git', ['init'], { cwd: targetDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: targetDir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: targetDir });
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  const workflow = new WorkflowService(store, config, assistant, new FakeHeavyAgents(), {
    executeVerification: false,
    orchestratorEnabled: true,
  });
  return { root, targetDir, store, assistant, workflow, config };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

async function createAwaitingDifficulty(harness: Awaited<ReturnType<typeof makeHarness>>) {
  const created = await harness.workflow.createTask({ title: 'Orchestrator task', task: 'Do a small thing.' });
  return harness.workflow.planTask(created.state.taskId);
}

async function createReadyPlan(harness: Awaited<ReturnType<typeof makeHarness>>) {
  const difficulty = await createAwaitingDifficulty(harness);
  return harness.workflow.reply(difficulty.state.taskId, 'low');
}

describe('orchestrator', () => {
  it('dispatches a difficulty choice from the first workflow gate', async () => {
    const harness = await makeHarness();
    try {
      const difficulty = await createAwaitingDifficulty(harness);
      harness.assistant.decisions.push({
        action: 'forward_to_workflow',
        intent: 'difficulty',
        difficulty: 'low',
        confidence: 0.95,
      });

      const turn = await orchestrateTaskMessage({
        taskId: difficulty.state.taskId,
        state: difficulty.state,
        userMessage: 'low',
        ruleHint: { intent: 'difficulty', reply: 'low' },
      }, harness);

      expect(turn.kind).toBe('background');
      if (turn.kind !== 'background') return;
      const result = await turn.run();

      expect(result.state.status).toBe('ready_for_decision');
      expect(result.state.difficulty).toBe('low');
      expect(harness.assistant.decisionInputs[0]?.allowedActions.map((action) => action.id)).toContain('difficulty');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('approves implementation only from a ready plan with high confidence', async () => {
    const harness = await makeHarness();
    try {
      const ready = await createReadyPlan(harness);
      harness.assistant.decisions.push({ action: 'approve_implementation', confidence: 0.95 });

      const turn = await orchestrateTaskMessage({
        taskId: ready.state.taskId,
        state: ready.state,
        userMessage: 'approve A',
        ruleHint: { intent: 'approve', reply: 'approve A' },
      }, harness);

      expect(turn.kind).toBe('background');
      if (turn.kind !== 'background') return;
      const result = await turn.run();

      expect(['awaiting_user_acceptance', 'completed']).toContain(result.state.status);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('does not approve implementation when confidence is low', async () => {
    const harness = await makeHarness();
    try {
      const ready = await createReadyPlan(harness);
      harness.assistant.decisions.push({ action: 'approve_implementation', confidence: 0.7 });

      const turn = await orchestrateTaskMessage({
        taskId: ready.state.taskId,
        state: ready.state,
        userMessage: 'approve A',
        ruleHint: { intent: 'approve', reply: 'approve A' },
      }, harness);

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.state.status).toBe('ready_for_decision');
      expect(harness.assistant.decisionInputs[1]?.rejectionReason).toContain('confidence');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('retries an illegal first action before dispatching', async () => {
    const harness = await makeHarness();
    try {
      const difficulty = await createAwaitingDifficulty(harness);
      harness.assistant.decisions.push(
        { action: 'approve_implementation', confidence: 0.95 },
        { action: 'forward_to_workflow', intent: 'difficulty', difficulty: 'medium', confidence: 0.95 },
      );

      const turn = await orchestrateTaskMessage({
        taskId: difficulty.state.taskId,
        state: difficulty.state,
        userMessage: 'medium',
        ruleHint: { intent: 'difficulty', reply: 'medium' },
      }, harness);

      expect(turn.kind).toBe('background');
      if (turn.kind !== 'background') return;
      const result = await turn.run();

      expect(result.state.status).toBe('ready_for_decision');
      expect(result.state.difficulty).toBe('medium');
      expect(harness.assistant.decisionInputs[1]?.rejectionReason).toContain('not valid');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('falls back to wait_for_user after repeated illegal actions', async () => {
    const harness = await makeHarness();
    try {
      const difficulty = await createAwaitingDifficulty(harness);
      harness.assistant.decisions.push(
        { action: 'approve_implementation', confidence: 0.95 },
        { action: 'forward_to_workflow', intent: 'approve', confidence: 0.95 },
        { action: 'forward_to_workflow', intent: 'difficulty', confidence: 0.95 },
      );

      const turn = await orchestrateTaskMessage({
        taskId: difficulty.state.taskId,
        state: difficulty.state,
        userMessage: 'continue',
      }, harness);

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.state.status).toBe('awaiting_difficulty_selection');
        expect(turn.rawMessage).toContain('没有通过当前 workflow 护栏');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('refreshes agent-prompt-preview without changing workflow status', async () => {
    const harness = await makeHarness();
    try {
      const difficulty = await createAwaitingDifficulty(harness);
      harness.assistant.decisions.push({ action: 'show_artifact', artifact: 'agent-prompt-preview', confidence: 0.95 });

      const turn = await orchestrateTaskMessage({
        taskId: difficulty.state.taskId,
        state: difficulty.state,
        userMessage: 'show architect prompt',
      }, harness);

      expect(turn.kind).toBe('reply');
      if (turn.kind !== 'reply') return;
      expect(turn.state.status).toBe(difficulty.state.status);
      expect(turn.state.artifacts['agent-prompt-preview']).toBeTruthy();
      expect(turn.rawMessage).toContain('agent-prompt-preview');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });
});
