import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, AssistantAdapter } from '../src/adapters.js';
import { BridgeAgentService } from '../src/bridgeAgent.js';
import { ProjectKnowledgeService } from '../src/projectKnowledge.js';
import type {
  BridgeAgentDecision,
  BridgeAgentInput,
  BridgeLiveProcessSnapshot,
  ControlChatResult,
  IntentResult,
  AssistantConfig,
  AssistantRouteResult,
  AssistantTextResult,
  OrchestratorDecision,
  PendingUserDecision,
  PlanResult,
  WorkflowDifficulty,
} from '../src/types.js';
import { WorkflowService } from '../src/workflow.js';

class FakeAssistant implements AssistantAdapter {
  decisions: BridgeAgentDecision[] = [];
  inputs: BridgeAgentInput[] = [];

  async decideBridgeAction(input: BridgeAgentInput): Promise<BridgeAgentDecision> {
    this.inputs.push(input);
    return this.decisions.shift() ?? { kind: 'reply', text: `reply: ${input.latestUserMessage}` };
  }

  async decideNextAction(): Promise<OrchestratorDecision> {
    return { action: 'wait_for_user', reason: 'unused', confidence: 1 };
  }

  async classifyIntent(): Promise<IntentResult> {
    return { intent: 'unknown', confidence: 0.1, requiresClarification: true, userFacingInterpretation: 'unused' };
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

  async handleControlChat(): Promise<ControlChatResult> {
    return { kind: 'answer', markdown: 'unused' };
  }

  async routeAfterFinalReview(): Promise<AssistantRouteResult> {
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

function makeConfig(targetDir: string): AssistantConfig {
  return {
    workspace: { targetDir },
    defaultProjectId: 'default',
    projects: [{ id: 'default', name: 'Default', targetDir, docsDir: 'project-docs/default', alwaysRead: [] }],
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

async function makeHarness(liveProcessProvider?: (taskId: string) => BridgeLiveProcessSnapshot[]): Promise<{
  root: string;
  targetDir: string;
  store: ArtifactStore;
  workflow: WorkflowService;
  assistant: FakeAssistant;
  agent: BridgeAgentService;
  config: AssistantConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  const workflow = new WorkflowService(store, config, assistant, new FakeHeavyAgents(), { executeVerification: false });
  return {
    root,
    targetDir,
    store,
    workflow,
    assistant,
    agent: liveProcessProvider
      ? new BridgeAgentService(workflow, store, assistant, config, undefined, liveProcessProvider)
      : new BridgeAgentService(workflow, store, assistant, config),
    config,
  };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rm(path, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }));
}

async function createTaskAtDifficultyGate(harness: Awaited<ReturnType<typeof makeHarness>>): Promise<string> {
  const created = await harness.workflow.createTask({ title: 'Agent task', task: 'Build it.' });
  await harness.workflow.planTask(created.state.taskId);
  return created.state.taskId;
}

async function createTaskAwaitingAcceptance(harness: Awaited<ReturnType<typeof makeHarness>>): Promise<string> {
  const taskId = await createTaskAtDifficultyGate(harness);
  await harness.workflow.reply(taskId, 'low');
  await harness.workflow.reply(taskId, 'approve A');
  expect((await harness.store.loadState(taskId)).status).toBe('awaiting_user_acceptance');
  return taskId;
}

const DEFAULT_DIRECTION_PROMPT = 'Options: 1) Accept current worktree as-is. 2) Revert unrelated files.';

function makePendingDecision(): PendingUserDecision {
  return {
    id: 'decision:test',
    source: 'plan_revision',
    question: 'Choose the product direction.',
    rationale: 'The planner needs a scope decision before continuing.',
    options: [
      { id: 'A', label: 'Keep the MVP narrow', impact: 'Planner continues with the smaller scoped implementation.' },
      { id: 'B', label: 'Expand the scope', impact: 'Planner includes additional product behavior now.' },
    ],
    recommendedOptionId: 'A',
    recommendationReason: 'The advisor recommends A because it fits the original request.',
    allowFreeform: true,
  };
}

function makeExtraHighPendingDecision(round = 3): PendingUserDecision {
  return {
    id: `extra-high-planning:round-${round}`,
    source: 'extra_high_planning',
    question: 'Reviewer still has blocking findings. What should happen next?',
    rationale: 'Extra High planning hit the review round limit with unresolved blockers.',
    options: [
      { id: 'A', label: 'Continue one round', impact: 'Run one more planner/reviewer round, then ask again if blockers remain.' },
      { id: 'B', label: 'Restart planning', impact: 'Return to planning from a clean direction and require approval again.' },
      { id: 'C', label: 'Execute current plan', impact: 'Implement the blocked plan as an explicit user override.' },
    ],
    recommendedOptionId: 'A',
    recommendationReason: 'One more round may resolve the current blockers without losing context.',
    allowFreeform: true,
  };
}

function makePlanArtifactFailureDecision(): PendingUserDecision {
  return {
    id: 'plan-artifact-failure:extra-high-initial-plan',
    source: 'plan_artifact_failure',
    question: 'The heavy agent did not provide a usable plan artifact. What should VibeCodingAssistant-ElonMa do next?',
    rationale: 'VibeCodingAssistant-ElonMa paused before sending an empty plan onward.',
    options: [
      { id: 'A', label: 'Retry planning', impact: 'Reruns planning from the original task.' },
      { id: 'B', label: 'Stop task', impact: 'Stops this task for manual inspection.' },
    ],
    recommendedOptionId: 'A',
    recommendationReason: 'Retrying is the normal recovery after fixing the agent output contract.',
    allowFreeform: true,
  };
}

async function createTaskWaitingForUserDirection(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  pendingUserPrompt = DEFAULT_DIRECTION_PROMPT,
  pendingUserDecision?: PendingUserDecision,
): Promise<string> {
  const created = await harness.workflow.createTask({ title: 'Direction task', task: 'Update docs.' });
  let state = await harness.store.writeArtifact(created.state, 'final-review', pendingUserPrompt);
  state = {
    ...state,
    status: 'waiting_user_direction',
    difficulty: 'low',
    lastDecision: 'ask_user_direction',
    pendingUserPrompt,
    ...(pendingUserDecision ? { pendingUserDecision } : {}),
    updatedAt: new Date().toISOString(),
  };
  await harness.store.saveState(state);
  return state.taskId;
}

async function createExtraHighPlanningPause(harness: Awaited<ReturnType<typeof makeHarness>>): Promise<string> {
  const prompt = [
    'Extra High reviewer concerns remain after round 3.',
    'A. Continue one round',
    'B. Restart planning',
    'C. Execute current plan',
  ].join('\n');
  const taskId = await createTaskWaitingForUserDirection(harness, prompt, makeExtraHighPendingDecision());
  let state = await harness.store.loadState(taskId);
  state = await harness.store.writeArtifact(state, 'revised-plan', '# Current blocked plan\n\n- Keep this visible.');
  state = await harness.store.writeArtifact(state, 'plan-rounds-log', '## Round 3\n\nverdict: issues_remain');
  await harness.store.saveState({
    ...state,
    difficulty: 'extra-high',
    reviewerRunCount: 3,
    revisionRound: 2,
    extraHighRoundLimit: 3,
    extraHighContinuationFromReview: false,
    pendingUserPrompt: prompt,
    pendingUserDecision: makeExtraHighPendingDecision(),
    updatedAt: new Date().toISOString(),
  });
  return taskId;
}

function activeTaskChat(taskId: string, chatId = 'task-chat') {
  return {
    chatKind: 'project' as const,
    projectChat: { projectId: 'default', hasActiveTask: true },
    activeTask: { chatId, taskId, title: 'Agent task', startedAt: new Date().toISOString() },
    canCreateTask: false,
  };
}

describe('BridgeAgentService', () => {
  it('uses choose_difficulty for low natural language choices', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'choose_difficulty', arguments: { difficulty: 'low', instruction: '按原 prompt 做' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'low，就按我原 prompt 做',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.difficulty).toBe('low');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('uses choose_difficulty for extra-high choices', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'choose_difficulty', arguments: { difficulty: 'extra-high' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'extra high',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.difficulty).toBe('extra-high');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('runs final-review follow-up from implementation_approved confirmation', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      const state = await harness.store.loadState(taskId);
      await harness.store.saveState({
        ...state,
        status: 'implementation_approved',
        implementationFollowup: {
          source: 'final_review',
          round: 1,
          reason: 'Contained defect remains.',
          createdAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'approve A',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        expect(turn.label).toBe('final-review follow-up');
      }
      expect(harness.assistant.inputs).toHaveLength(0);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('rejects run_followup without an active follow-up scope', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      const state = await harness.store.loadState(taskId);
      await harness.store.saveState({
        ...state,
        status: 'implementation_approved',
        updatedAt: new Date().toISOString(),
      });
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'run_followup', arguments: {} },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'approve A',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.auditAction).toBe('guard:state-mismatch');
        expect(turn.messages[0]?.text).toContain('no active final-review follow-up scope');
      }
      const next = await harness.store.loadState(taskId);
      expect(next.status).toBe('implementation_approved');
      expect(next.implementationFollowup).toBeUndefined();
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('rejects partial extra difficulty values', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'choose_difficulty', arguments: { difficulty: 'extra' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'extra',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.messages[0]?.text).toContain('没有执行');
      expect((await harness.store.loadState(taskId)).status).toBe('awaiting_difficulty_selection');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('answers questions without mutating state', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({ kind: 'reply', text: '难度决定 Planner/Reviewer 的组合。' });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '为什么要选难度',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      expect((await harness.store.loadState(taskId)).status).toBe('awaiting_difficulty_selection');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('stops tasks via stop_task tool calls', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'stop_task', arguments: {} } });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '我想取消这个任务',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.clearActiveTask).toEqual({ taskId });
      expect((await harness.store.loadState(taskId)).status).toBe('stopped');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('accepts completed work via accept_task tool calls', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAwaitingAcceptance(harness);
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'accept_task', arguments: {} } });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'Accept',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.clearActiveTask).toEqual({ taskId });
      const state = await harness.store.loadState(taskId);
      expect(state.status).toBe('completed');
      expect(state.artifacts['final-report']).toBeTruthy();
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('answers final-review user direction instead of treating option 1 as task acceptance', async () => {
    const harness = await makeHarness();
    try {
      const created = await harness.workflow.createTask({ title: 'Direction task', task: 'Update docs.' });
      let state = await harness.store.writeArtifact(created.state, 'final-review', 'Options: 1) Accept current worktree as-is. 2) Revert unrelated files.');
      state = {
        ...state,
        status: 'waiting_user_direction',
        difficulty: 'low',
        lastDecision: 'ask_user_direction',
        pendingUserPrompt: 'Options: 1) Accept current worktree as-is. 2) Revert unrelated files.',
        updatedAt: new Date().toISOString(),
      };
      await harness.store.saveState(state);
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'answer_user_direction', arguments: { answer: '1' } } });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '1',
        ...activeTaskChat(state.taskId),
      });

      expect(turn.kind).toBe('reply');
      const next = await harness.store.loadState(state.taskId);
      expect(next.status).toBe('awaiting_user_acceptance');
      expect(next.pendingUserPrompt).toBeUndefined();
      expect(next.lastDecision).toBe('user direction: 1');
      expect(await harness.store.readArtifact(next, 'decision-log')).toContain('user direction: 1');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('blocks soft-future workflow claims while waiting for user direction', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskWaitingForUserDirection(harness);
      harness.assistant.decisions.push({ kind: 'reply', text: '收到，我会把你的选择 1 反馈给 workflow。' });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '1',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      expect(turn.auditAction).toBe('guard:fake-claim');
      if (turn.kind === 'reply') {
        const text = turn.messages[0]?.text ?? '';
        expect(text).toContain(DEFAULT_DIRECTION_PROMPT);
        expect(text).toContain('answer_user_direction');
        expect(text).toContain('记录用户选择并反馈给 workflow');
      }
      const next = await harness.store.loadState(taskId);
      expect(next.status).toBe('waiting_user_direction');
      expect(next.pendingUserPrompt).toBe(DEFAULT_DIRECTION_PROMPT);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('includes truncated pending prompts in waiting-direction no-op replies', async () => {
    const harness = await makeHarness();
    try {
      const pendingUserPrompt = [
        'Options:',
        '1) Accept current worktree as-is after checking the final-review scope and preserving unrelated user edits.',
        '2) Revert unrelated files before acceptance and document why the reroute is needed.',
        '3) Ask for a narrower follow-up task before proceeding.',
      ].join(' ');
      const taskId = await createTaskWaitingForUserDirection(harness, pendingUserPrompt);
      harness.assistant.decisions.push({ kind: 'reply', text: '收到，我会把你的选择 1 反馈给 workflow。' });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '1',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        const text = turn.messages[0]?.text ?? '';
        expect(text).toContain(`${pendingUserPrompt.slice(0, 197)}...`);
        expect(text).toContain('必须用 `answer_user_direction` 提交答案');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('does not auto-submit clarifying questions as user direction answers', async () => {
    const harness = await makeHarness();
    try {
      const decision = makePendingDecision();
      const prompt = [
        '需要你做一个产品/范围/方向决定。',
        `问题：${decision.question}`,
        'A. Keep the MVP narrow',
        'B. Expand the scope',
      ].join('\n');
      const taskId = await createTaskWaitingForUserDirection(harness, prompt, decision);
      harness.assistant.decisions.push({ kind: 'reply', text: '当前需要你决定 A/B 两个产品方向；我可以继续解释差异。' });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '什么 decision',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      expect(turn.auditAction).toBe('guard:direction-text-blocked');
      const next = await harness.store.loadState(taskId);
      expect(next.status).toBe('waiting_user_direction');
      expect(next.pendingUserDecision).toEqual(decision);
      expect(await harness.store.readArtifact(next, 'decision-log').catch(() => '')).not.toContain('什么 decision');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('continues Extra High planning as a background job and sends the current plan files immediately', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createExtraHighPlanningPause(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'answer_user_direction', arguments: { answer: 'A' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'A',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        expect(turn.label).toBe('extra-high planning');
        expect(turn.startedMessage.text).toContain('继续 Extra High planning 一轮');
        expect(turn.startedMessage.text).toContain('revised-plan 和 plan-rounds-log');
        expect(turn.startedMessage.files?.map((file) => file.name)).toEqual([
          'revised-plan.md',
          'plan-rounds-log.md',
        ]);
      }
      expect((await harness.store.loadState(taskId)).status).toBe('waiting_user_direction');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('labels A-prefixed Extra High guidance as planning instead of implementation', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createExtraHighPlanningPause(harness);
      const answer = [
        'A: Continue one more round, and carry this guidance into the next Extra High planning/reviewer round.',
        'Use an existing real integration point in the current codebase, or add a minimal testable harness as part of the plan.',
      ].join(' ');
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'answer_user_direction', arguments: { answer } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: answer,
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        expect(turn.label).toBe('extra-high planning');
        expect(turn.startedMessage.text).toContain('继续 Extra High planning 一轮');
        expect(turn.startedMessage.text).not.toContain('直接执行当前 Extra High plan');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('starts Extra High option C as a background implementation override', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createExtraHighPlanningPause(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'answer_user_direction', arguments: { answer: 'C' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'C',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        expect(turn.label).toBe('extra-high implementing');
        expect(turn.startedMessage.text).toContain('直接执行当前 Extra High plan');
        expect(turn.startedMessage.files?.map((file) => file.name)).toEqual([
          'revised-plan.md',
          'plan-rounds-log.md',
        ]);
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('attaches the current Extra High plan files when a paused approve attempt is rejected', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createExtraHighPlanningPause(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'approve_plan', arguments: {} },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'approve A',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.messages[0]?.text).toContain('Continue one round');
        expect(turn.messages[0]?.files?.map((file) => file.name)).toEqual([
          'revised-plan.md',
          'plan-rounds-log.md',
        ]);
      }
      expect((await harness.store.loadState(taskId)).status).toBe('waiting_user_direction');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('auto-routes neutral acknowledgements to answer_user_direction for numeric answers', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskWaitingForUserDirection(harness);
      harness.assistant.decisions.push({ kind: 'reply', text: '好的，我理解你的选择。' });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '1',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      expect(turn.auditAction).toBe('guard:direction-autoanswer');
      const next = await harness.store.loadState(taskId);
      expect(next.status).toBe('awaiting_user_acceptance');
      expect(next.pendingUserPrompt).toBeUndefined();
      expect(next.lastDecision).toBe('user direction: 1');
      expect(await harness.store.readArtifact(next, 'decision-log')).toContain('user direction: 1');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('auto-routes short continuation replies to answer_user_direction for artifact failures', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskWaitingForUserDirection(
        harness,
        'Heavy agent did not provide a usable plan artifact. Reply A to retry planning or B to stop.',
        makePlanArtifactFailureDecision(),
      );
      harness.assistant.decisions.push({ kind: 'reply', text: '收到，我继续。' });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '继续',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      expect(turn.auditAction).toBe('guard:direction-autoanswer');
      const next = await harness.store.loadState(taskId);
      expect(next.status).toBe('ready_for_decision');
      expect(next.pendingUserDecision).toBeUndefined();
      expect(next.lastDecision).toBe('user direction: 继续');
      expect(next.requestedChanges.join('\n')).toContain('Retry planning after plan artifact failure');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('auto-routes reply_to_user acknowledgements to answer_user_direction for numeric answers', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskWaitingForUserDirection(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'reply_to_user', arguments: { text: '好的' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '1',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      expect(turn.auditAction).toBe('guard:direction-autoanswer');
      const next = await harness.store.loadState(taskId);
      expect(next.status).toBe('awaiting_user_acceptance');
      expect(next.pendingUserPrompt).toBeUndefined();
      expect(next.lastDecision).toBe('user direction: 1');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('passes through legitimate clarifying questions while waiting for user direction', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskWaitingForUserDirection(harness);
      harness.assistant.decisions.push({ kind: 'reply', text: '你说的选项 1 是指 accept 还是 revert？' });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '我不确定选项 1 的范围，先解释 accept current worktree 和 revert unrelated files 的区别',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      expect(turn.auditAction).toBeUndefined();
      if (turn.kind === 'reply') expect(turn.messages[0]?.text).toBe('你说的选项 1 是指 accept 还是 revert？');
      expect((await harness.store.loadState(taskId)).status).toBe('waiting_user_direction');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('routes stale accept_task tool calls to user-direction handling while waiting for direction', async () => {
    const harness = await makeHarness();
    try {
      const created = await harness.workflow.createTask({ title: 'Fallback direction task', task: 'Update docs.' });
      let state = await harness.store.writeArtifact(created.state, 'final-review', 'Options: 1) Accept current worktree as-is. 2) Revert unrelated files.');
      state = {
        ...state,
        status: 'waiting_user_direction',
        difficulty: 'low',
        lastDecision: 'ask_user_direction',
        pendingUserPrompt: 'Options: 1) Accept current worktree as-is. 2) Revert unrelated files.',
        updatedAt: new Date().toISOString(),
      };
      await harness.store.saveState(state);
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'accept_task', arguments: {} } });

      await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '1',
        ...activeTaskChat(state.taskId),
      });

      expect((await harness.store.loadState(state.taskId)).status).toBe('awaiting_user_acceptance');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('renders awaiting acceptance status without saying the plan still needs approval', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAwaitingAcceptance(harness);
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'show_status', arguments: {} } });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '现在在哪个阶段',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.messages[0]?.text).toContain('等待你验收');
        expect(turn.messages[0]?.text).toContain('task recording');
        expect(turn.messages[0]?.text).not.toContain('等待批准实现');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('includes live worker observation in task status', async () => {
    const liveProcesses: BridgeLiveProcessSnapshot[] = [{
      id: 'run-1',
      command: 'codex',
      cwd: 'C:\\workspace\\reader',
      startedAt: new Date(Date.now() - 90_000).toISOString(),
      elapsedMs: 90_000,
      pid: 1234,
      role: 'developer',
      profileName: 'implementer',
      label: 'developer:implementer',
      stdoutTail: [
        'Reading src/components/Reader.tsx',
        'Editing vocabulary overlay positioning',
        'Running focused tests',
      ].join('\n'),
    }];
    const harness = await makeHarness((taskId) => liveProcesses.map((process) => ({ ...process, taskId })));
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      const state = await harness.store.loadState(taskId);
      await harness.store.saveState({
        ...state,
        status: 'execution_unit_implementing',
        difficulty: 'low',
        currentExecutionIndex: 0,
        executionQueue: [{
          index: 1,
          slug: 'main',
          name: 'Fix reader overlay',
          status: 'In Progress',
          fileName: '01-main.md',
        }],
        updatedAt: new Date().toISOString(),
      });
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'show_status', arguments: {} } });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '现在做到哪一步了',
        ...activeTaskChat(taskId),
        runningJob: { taskId, label: 'implementing', startedAt: new Date().toISOString() },
      });

      expect(harness.assistant.inputs[0]?.liveProcesses?.[0]?.label).toBe('developer:implementer');
      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        const text = turn.messages[0]?.text ?? '';
        expect(text).toContain('实时观察');
        expect(text).toContain('developer:implementer');
        expect(text).toContain('Fix reader overlay');
        expect(text).toContain('Running focused tests');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('marks internal task status as orphaned when no running job or worker exists', async () => {
    const harness = await makeHarness(() => []);
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      const state = await harness.store.loadState(taskId);
      await harness.store.saveState({
        ...state,
        status: 'execution_unit_implementing',
        difficulty: 'low',
        currentExecutionIndex: 0,
        executionQueue: [{
          index: 1,
          slug: 'main',
          name: 'Main',
          status: 'In Progress',
          fileName: '01-main.md',
        }],
        updatedAt: new Date().toISOString(),
      });
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'show_status', arguments: {} } });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '当前进度',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        const text = turn.messages[0]?.text ?? '';
        expect(text).toContain('后台任务未运行');
        expect(text).toContain('可能是上次 VibeCodingAssistant-ElonMa 重启或进程中断');
        expect(text).toContain('restart');
        expect(text).not.toContain('后台任务：implementing');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('returns a safe explanation for invalid tool arguments', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'choose_difficulty', arguments: { difficulty: 'tiny' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'tiny difficulty',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.messages[0]?.text).toContain('没有执行');
      expect((await harness.store.loadState(taskId)).status).toBe('awaiting_difficulty_selection');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('adds a project via add_project and makes it active for the current chat', async () => {
    const harness = await makeHarness();
    const projectDir = join(harness.root, 'Assistant VibeCodingAssistant-ElonMa');
    try {
      await mkdir(projectDir);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'add_project',
          arguments: { targetDir: projectDir, name: 'VibeCodingAssistant-ElonMa' },
        },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: `添加项目，路径是 ${projectDir}`,
        chatKind: 'control',
        canCreateTask: true,
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind !== 'reply') return;
      expect(turn.activeProjectId).toBe('assistant-vibecodingassistant-elonma');
      expect(turn.messages[0]?.text).toContain('项目已添加');
      expect(harness.config.projects?.some((project) => project.id === 'assistant-vibecodingassistant-elonma')).toBe(true);
      const registry = JSON.parse(await readFile(join(harness.root, 'assistant.projects.local.json'), 'utf8')) as {
        projects: Array<{ id: string; targetDir: string }>;
      };
      expect(registry.projects[0]).toMatchObject({ id: 'assistant-vibecodingassistant-elonma', targetDir: projectDir });
    } finally {
      await cleanup([harness.root, harness.targetDir, projectDir]);
    }
  });

  it('creates the next task in the project added during the same process', async () => {
    const harness = await makeHarness();
    const projectDir = join(harness.root, 'Assistant VibeCodingAssistant-ElonMa');
    try {
      await mkdir(projectDir);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'add_project',
          arguments: { targetDir: projectDir, name: 'VibeCodingAssistant-ElonMa' },
        },
      });
      const addTurn = await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: `添加项目 ${projectDir}`,
        chatKind: 'control',
        canCreateTask: true,
      });
      expect(addTurn.kind).toBe('reply');
      if (addTurn.kind !== 'reply') return;

      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'create_task',
          arguments: { title: 'VibeCodingAssistant-ElonMa task', prompt: 'Create a small VibeCodingAssistant-ElonMa task.' },
        },
      });
      const createTurn = await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: '创建一个 VibeCodingAssistant-ElonMa task',
        chatKind: 'control',
        activeProjectId: addTurn.activeProjectId ?? undefined,
        canCreateTask: true,
      });

      expect(createTurn.kind).toBe('task_created');
      if (createTurn.kind !== 'task_created') return;
      expect(createTurn.projectId).toBe('assistant-vibecodingassistant-elonma');
      expect(createTurn.projectName).toBe('VibeCodingAssistant-ElonMa');
      const state = await harness.store.loadState(createTurn.taskId);
      expect(state.projectId).toBe('assistant-vibecodingassistant-elonma');
      await expect(readFile(join(projectDir, 'task', createTurn.taskId, 'README.md'), 'utf8'))
        .resolves.toContain('VibeCodingAssistant-ElonMa task');
    } finally {
      await cleanup([harness.root, harness.targetDir, projectDir]);
    }
  });

  it('lists projects with active and default markers', async () => {
    const harness = await makeHarness();
    try {
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'list_projects', arguments: {} },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: '项目列表',
        chatKind: 'control',
        activeProjectId: 'default',
        canCreateTask: true,
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.messages[0]?.text).toContain('default: Default');
        expect(turn.messages[0]?.text).toContain('默认');
        expect(turn.messages[0]?.text).toContain('当前');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('catches async tool failures and explains instead of throwing out to transport', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAwaitingAcceptance(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'show_artifact', arguments: { artifact: 'final-report' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'show final report',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.messages[0]?.text).toContain('不是权限问题');
        expect(turn.messages[0]?.text).toContain('final-report.md 现在还没生成');
      }
      expect((await harness.store.loadState(taskId)).status).toBe('awaiting_user_acceptance');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('explains missing implementation logs while a task is still implementing', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      const state = await harness.store.loadState(taskId);
      await harness.store.saveState({
        ...state,
        status: 'execution_unit_implementing',
        difficulty: 'high',
        updatedAt: new Date().toISOString(),
      });
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'show_artifact', arguments: { artifact: 'implementation-log' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '你确定他没卡住执行',
        ...activeTaskChat(taskId),
        runningJob: { taskId, label: 'implementing', startedAt: new Date().toISOString() },
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.messages[0]?.text).toContain('不是权限问题');
        expect(turn.messages[0]?.text).toContain('implementation-log.md 现在还没生成');
        expect(turn.messages[0]?.text).toContain('Developer 还在执行');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('forwards recentMessages and chatSummary into the bridge input', async () => {
    const harness = await makeHarness();
    try {
      harness.assistant.decisions.push({ kind: 'reply', text: '好的，正在创建。' });
      await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: '现在创建吧',
        chatKind: 'control',
        canCreateTask: true,
        recentMessages: [
          { role: 'assistant', text: '要为 IReader 创建 Project Chat 吗？', at: '2025-01-01T00:00:00Z' },
        ],
        chatSummary: {
          summary: '用户正在为 IReader 配置 Project Chat',
          messageCountCovered: 4,
          updatedAt: '2025-01-01T00:00:00Z',
        },
      });

      const input = harness.assistant.inputs[0];
      expect(input?.recentMessages?.[0]?.text).toBe('要为 IReader 创建 Project Chat 吗？');
      expect(input?.chatSummary?.summary).toBe('用户正在为 IReader 配置 Project Chat');
      expect(input?.latestUserMessage).toBe('现在创建吧');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('omits recentMessages key when there is no prior history', async () => {
    const harness = await makeHarness();
    try {
      harness.assistant.decisions.push({ kind: 'reply', text: 'hi' });
      await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: 'hello',
        chatKind: 'control',
        canCreateTask: true,
      });
      expect(harness.assistant.inputs[0]?.recentMessages).toBeUndefined();
      expect(harness.assistant.inputs[0]?.chatSummary).toBeUndefined();
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('retrieves long-term memory snippets via ProjectKnowledgeService when configured', async () => {
    const harness = await makeHarness();
    try {
      const docs = join(harness.root, 'project-docs', 'default');
      await mkdir(docs, { recursive: true });
      await readFile;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(docs, 'memory.md'),
        '# Project Chat 决策\n之前决定 Project Chat 不绑定 task，因为 task 只是 Project Chat 内的短期 active 状态。\n',
        'utf8',
      );
      const agentWithKnowledge = new BridgeAgentService(
        harness.workflow,
        harness.store,
        harness.assistant,
        harness.config,
        new ProjectKnowledgeService(harness.root),
      );

      harness.assistant.decisions.push({ kind: 'reply', text: '让我看看以前的决定。' });
      await agentWithKnowledge.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: '之前我们为什么决定 Project Chat 不绑定 task？',
        chatKind: 'control',
        canCreateTask: true,
        activeProjectId: 'default',
      });

      const input = harness.assistant.inputs[0];
      expect(input?.retrievedMemory?.snippets?.length).toBeGreaterThan(0);
      expect(input?.retrievedMemory?.snippets?.[0]?.source).toBe('memory.md');
      expect(input?.retrievedMemory?.snippets?.[0]?.text).toContain('Project Chat 不绑定 task');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });
});
