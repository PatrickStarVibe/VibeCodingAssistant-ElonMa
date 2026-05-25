import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, AssistantAdapter } from '../src/adapters.js';
import { AssistantConversationService, parseExplicitWorkflowCommand, parseTaskRequest } from '../src/conversation.js';
import type {
  ControlChatResult,
  FinalReviewResult,
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

class FakeAssistant implements AssistantAdapter {
  controlProjectContexts: string[] = [];
  composeInputs: string[] = [];
  composePendingPrompts: (string | undefined)[] = [];
  prefixComposedReplies = false;
  intents: IntentResult[] = [];
  decisions: OrchestratorDecision[] = [];
  decisionInputs: OrchestratorDecisionInput[] = [];

  async decideNextAction(input: OrchestratorDecisionInput): Promise<OrchestratorDecision> {
    this.decisionInputs.push(input);
    return this.decisions.shift() ?? { action: 'wait_for_user', reason: 'test fallback', confidence: 1 };
  }

  async createRevisionInstructions(): Promise<AssistantTextResult> {
    return { markdown: 'revise instructions', needsUserDecision: false };
  }

  async explainRevisedPlan(): Promise<AssistantTextResult> {
    return { markdown: 'explanation', needsUserDecision: false };
  }

  async answerQuestion(input: { question: string }): Promise<string> {
    return `answer: ${input.question}`;
  }

  async interpretAmbiguousReply(input: { reply: string }): Promise<string> {
    return `confirm: ${input.reply}`;
  }

  async classifyIntent(input: { userMessage: string }): Promise<IntentResult> {
    const next = this.intents.shift();
    if (next) return next;
    const message = input.userMessage.toLocaleLowerCase();
    if (message === 'status' || message === '/status') return intent('status', 'status');
    if (message === 'summary' || message === '/summary') return intent('summary', 'summary');
    if (message.includes('?') || input.userMessage.includes('？')) return intent('ask', 'question');
    if (message.includes('high')) return intent('difficulty', 'high difficulty', { difficulty: 'high' });
    if (message.includes('medium') || input.userMessage.includes('默认')) return intent('difficulty', 'medium difficulty', { difficulty: 'medium' });
    if (message.includes('low')) return intent('difficulty', 'low difficulty', { difficulty: 'low' });
    if (message === 'a' || input.userMessage.includes('可以') || input.userMessage.includes('继续')) return intent('approve', 'approve');
    return intent('unknown', 'unclear', { confidence: 0.4, requiresClarification: true });
  }

  async composeReply(input: { rawMessage: string; pendingPrompt?: string }): Promise<{ text: string }> {
    this.composeInputs.push(input.rawMessage);
    this.composePendingPrompts.push(input.pendingPrompt);
    return { text: this.prefixComposedReplies ? `COMPOSED: ${input.rawMessage}` : input.rawMessage };
  }

  async handleControlChat(input: {
    message: string;
    pendingProposal?: TaskProposal;
    mode: 'message' | 'edit';
    projectContext: string;
  }): Promise<ControlChatResult> {
    this.controlProjectContexts.push(input.projectContext);
    if (input.mode === 'edit' && input.pendingProposal) {
      return {
        kind: 'proposal',
        proposal: {
          ...input.pendingProposal,
          task: `${input.pendingProposal.task}\nEdit: ${input.message}`,
        },
      };
    }
    return { kind: 'answer', markdown: `chat answer: ${input.message}` };
  }

  async routeAfterFinalReview(): Promise<AssistantRouteResult> {
    return { route: 'complete', reason: 'ok' };
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

  async implement(): Promise<{ markdown: string; changedFiles: string[] }> {
    return { markdown: 'implemented', changedFiles: [] };
  }

  async finalReview(): Promise<FinalReviewResult> {
    return { markdown: 'final', passed: true };
  }
}

function makeConfig(targetDir: string): AssistantConfig {
  return {
    workspace: { targetDir },
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
      'extra-high': {
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

async function makeConversation(options: { orchestratorEnabled?: boolean } = {}): Promise<{
  root: string;
  targetDir: string;
  service: AssistantConversationService;
  assistant: FakeAssistant;
  store: ArtifactStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  const workflow = new WorkflowService(store, config, assistant, new FakeHeavyAgents(), { executeVerification: false, ...options });
  return {
    root,
    targetDir,
    service: new AssistantConversationService(workflow, store, assistant, config, options),
    assistant,
    store,
  };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

async function startDifficultyGate(service: AssistantConversationService, taskId: string): Promise<void> {
  const turn = service.startPlanning(taskId);
  const result = await turn.run();
  expect(result.state.status).toBe('awaiting_difficulty_selection');
}

describe('AssistantConversationService', () => {
  it('parses direct task creation requests only', () => {
    expect(parseTaskRequest('/create Feedback UI\nFix hover behavior')).toEqual({
      title: 'Feedback UI',
      task: 'Fix hover behavior',
    });
    expect(parseTaskRequest('create task: Feedback UI')).toEqual({
      title: 'Feedback UI',
      task: 'Feedback UI',
    });
    expect(parseTaskRequest('new task: Feedback UI')).toEqual({
      title: 'Feedback UI',
      task: 'Feedback UI',
    });
    expect(parseTaskRequest('/new Feedback UI')).toBeUndefined();
    expect(parseTaskRequest('status')).toBeUndefined();
    expect(parseTaskRequest('summary')).toBeUndefined();
    expect(parseTaskRequest('hello')).toBeUndefined();
  });

  it('routes readonly, question, artifact, and blocked mutating task messages', async () => {
    const { root, targetDir, service } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Chat task', task: 'Build the chat bridge.' });

      const status = await service.routeTaskMessage(created.state.taskId, 'status');
      expect(status.kind).toBe('reply');

      const question = await service.routeTaskMessage(created.state.taskId, 'what is the risk?');
      expect(question.kind).toBe('reply');
      if (question.kind === 'reply') expect(question.messages[0]?.text).toContain('answer:');

      const artifact = await service.routeTaskMessage(created.state.taskId, '/show original-task');
      expect(artifact.kind).toBe('reply');
      if (artifact.kind === 'reply') expect(artifact.messages[0]?.files?.[0]?.name).toBe('original-task.md');

      const approve = await service.routeTaskMessage(created.state.taskId, 'A');
      expect(approve.kind).toBe('reply');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('starts at the difficulty gate without generating a rewritten summary artifact', async () => {
    const { root, targetDir, service, store } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Decision task', task: 'Build the chat bridge.' });
      await startDifficultyGate(service, created.state.taskId);
      const state = await store.loadState(created.state.taskId);

      expect(state.status).toBe('awaiting_difficulty_selection');
      expect(Object.keys(state.artifacts)).toEqual(['original-task']);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('routes explicit restart commands without LLM intent classification', async () => {
    const { root, targetDir, service, assistant, store } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Restart chat task', task: 'Original user prompt.' });
      await startDifficultyGate(service, created.state.taskId);
      const state = await store.loadState(created.state.taskId);
      await store.saveState({
        ...state,
        status: 'stopped',
        difficulty: 'medium',
        stoppedReason: 'test stopped state',
      });
      assistant.intents.push(intent('ask', 'wrong classifier route'));

      const turn = await service.routeTaskMessage(
        created.state.taskId,
        'restart: redesign around the production runtime path',
      );

      expect(turn.kind).toBe('background');
      expect(assistant.intents).toHaveLength(1);
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.status).toBe('ready_for_decision');
        expect(result.state.requestedChanges).toContain(
          'Restart/redesign prompt:\nredesign around the production runtime path',
        );
      }
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('routes exact difficulty commands before LLM intent classification', async () => {
    const { root, targetDir, service, assistant } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Exact command task', task: 'Original user prompt.' });
      await startDifficultyGate(service, created.state.taskId);
      assistant.intents.push(intent('ask', 'wrong classifier route'));

      const turn = await service.routeTaskMessage(created.state.taskId, 'low');

      expect(turn.kind).toBe('background');
      expect(assistant.intents).toHaveLength(1);
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.status).toBe('ready_for_decision');
        expect(result.state.difficulty).toBe('low');
      }
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('uses explicit mutating commands as orchestrator hints when the flag is on', async () => {
    const { root, targetDir, service, assistant } = await makeConversation({ orchestratorEnabled: true });
    try {
      const created = await service.createTask({ title: 'Orchestrated command task', task: 'Original user prompt.' });
      await startDifficultyGate(service, created.state.taskId);
      assistant.intents.push(intent('ask', 'wrong classifier route'));
      assistant.decisions.push({ action: 'respond', text: 'orchestrated response', confidence: 1 });

      const turn = await service.routeTaskMessage(created.state.taskId, 'low');

      expect(turn.kind).toBe('reply');
      expect(assistant.intents).toHaveLength(1);
      expect(assistant.decisionInputs[0]?.ruleHint?.intent).toBe('difficulty');
      if (turn.kind === 'reply') expect(turn.messages[0]?.text).toContain('orchestrated response');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('keeps status, summary, show, and stop on deterministic paths when the flag is on', async () => {
    const { root, targetDir, service, assistant } = await makeConversation({ orchestratorEnabled: true });
    try {
      const created = await service.createTask({ title: 'Fast path task', task: 'Original user prompt.' });
      await startDifficultyGate(service, created.state.taskId);
      assistant.decisions.push({ action: 'respond', text: 'should not be used', confidence: 1 });

      const status = await service.routeTaskMessage(created.state.taskId, 'status');
      const summary = await service.routeTaskMessage(created.state.taskId, 'summary');
      const show = await service.routeTaskMessage(created.state.taskId, '/show original-task');
      const stop = await service.routeTaskMessage(created.state.taskId, 'stop');
      const chineseStop = await service.routeTaskMessage(created.state.taskId, '取消task');

      expect(status.kind).toBe('reply');
      expect(summary.kind).toBe('reply');
      expect(show.kind).toBe('reply');
      expect(stop.kind).toBe('background');
      expect(chineseStop.kind).toBe('background');
      expect(assistant.decisionInputs).toHaveLength(0);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('treats Chinese cancel as a deterministic stop command', async () => {
    const { root, targetDir, service, store } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Chinese stop task', task: 'Original user prompt.' });
      await startDifficultyGate(service, created.state.taskId);

      const command = parseExplicitWorkflowCommand('我想取消这个任务', await store.loadState(created.state.taskId));
      expect(command?.intent).toBe('stop');

      const turn = await service.routeTaskMessage(created.state.taskId, '我想取消这个任务');
      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.status).toBe('stopped');
      }
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('lets the classifier request the planner prompt preview without changing status', async () => {
    const { root, targetDir, service, assistant, store } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Prompt preview task', task: 'Original user prompt.' });
      await startDifficultyGate(service, created.state.taskId);
      assistant.intents.push({
        intent: 'ask',
        artifact: 'agent-prompt-preview',
        confidence: 0.95,
        requiresClarification: false,
        userFacingInterpretation: 'show planner prompt',
      });

      const turn = await service.routeTaskMessage(created.state.taskId, 'show architect prompt');

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.messages[0]?.files?.[0]?.name).toBe('agent-prompt-preview.md');
        expect(turn.messages[0]?.text).toContain('Agent Prompt Preview');
      }
      expect((await store.loadState(created.state.taskId)).status).toBe('awaiting_difficulty_selection');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('can choose difficulty from natural language and carry instructions', async () => {
    const { root, targetDir, service, assistant, store } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Combined gate task', task: 'Original user prompt.' });
      await startDifficultyGate(service, created.state.taskId);
      assistant.intents.push({
        intent: 'difficulty',
        difficulty: 'high',
        instruction: 'Use the original user prompt as the planning input.',
        confidence: 0.95,
        requiresClarification: false,
        userFacingInterpretation: 'choose high difficulty',
      });

      const turn = await service.routeTaskMessage(created.state.taskId, 'high difficulty, use my original prompt');

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.status).toBe('ready_for_decision');
        expect(result.state.difficulty).toBe('high');
      }
      const state = await store.loadState(created.state.taskId);
      expect(state.requestedChanges).toContain('Use the original user prompt as the planning input.');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('does not pass stale pending prompts into task background acknowledgements', async () => {
    const { root, targetDir, service, assistant } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'No stale prompt task', task: 'Build the chat bridge.' });
      await startDifficultyGate(service, created.state.taskId);
      assistant.intents.push({
        intent: 'difficulty',
        difficulty: 'medium',
        confidence: 0.95,
        requiresClarification: false,
        userFacingInterpretation: 'choose medium',
      });

      const turn = await service.routeTaskMessage(created.state.taskId, 'medium');

      expect(turn.kind).toBe('background');
      expect(assistant.composePendingPrompts.at(-1)).toBeUndefined();
      if (turn.kind === 'background') expect(turn.startedMessage.text).not.toContain('Choose workflow difficulty');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('asks for confirmation when the task chat route is low confidence', async () => {
    const { root, targetDir, service, assistant, store } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Low confidence task', task: 'Build the chat bridge.' });
      await startDifficultyGate(service, created.state.taskId);
      assistant.intents.push({
        intent: 'difficulty',
        confidence: 0.4,
        requiresClarification: true,
        userFacingInterpretation: 'Do you mean high difficulty?',
        difficulty: 'high',
      });
      const turn = await service.routeTaskMessage(created.state.taskId, 'maybe high');

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.messages[0]?.text).toContain('Do you mean high');
      expect((await store.loadState(created.state.taskId)).status).toBe('awaiting_difficulty_selection');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('blocks routed workflow actions that are not allowed in the current state', async () => {
    const { root, targetDir, service, assistant, store } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Blocked route task', task: 'Build the chat bridge.' });
      assistant.intents.push({
        intent: 'approve',
        confidence: 0.95,
        requiresClarification: false,
        userFacingInterpretation: 'The user wants to start implementation.',
      });

      const turn = await service.routeTaskMessage(created.state.taskId, 'start implementation');

      expect(turn.kind).toBe('reply');
      expect((await store.loadState(created.state.taskId)).status).toBe('created');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('injects project Markdown context into unbound control chat', async () => {
    const { root, targetDir, service, assistant } = await makeConversation();
    try {
      const docsDir = join(root, 'project-docs', 'default');
      await mkdir(docsDir, { recursive: true });
      await writeFile(join(docsDir, 'ireader.md'), '# iReader\nProject memory is readable from General chat.\n', 'utf8');

      const turn = await service.routeControlMessage('read iReader docs');

      expect(turn.kind).toBe('reply');
      expect(assistant.controlProjectContexts[0]).toContain('ireader.md#iReader');
      expect(assistant.controlProjectContexts[0]).toContain('Project memory is readable');
    } finally {
      await cleanup([root, targetDir]);
    }
  });
});
