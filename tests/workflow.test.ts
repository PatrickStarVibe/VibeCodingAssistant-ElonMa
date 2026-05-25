import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, AssistantAdapter } from '../src/adapters.js';
import type {
  AgentPromptRecord,
  ControlChatResult,
  FinalReviewResult,
  IntentResult,
  AssistantConfig,
  AssistantRouteResult,
  OrchestratorDecision,
  PlanResult,
  TaskProposal,
  WorkflowDifficulty,
  WorkflowRoleName,
} from '../src/types.js';
import { createHeavyAgentAdapter } from '../src/adapters.js';
import { WorkflowService, type WorkflowResult } from '../src/workflow.js';

const execFileAsync = promisify(execFile);
const gb18030Decoder = new TextDecoder('gb18030');
const utf8Encoder = new TextEncoder();

function simulateUtf8ReadAsGbk(value: string): string {
  return gb18030Decoder.decode(utf8Encoder.encode(value));
}

class FakeAssistant implements AssistantAdapter {
  route: AssistantRouteResult = { route: 'complete', reason: 'No blocking issues.' };
  fallbackReply = 'Please reply with approve A, reject B, or revise C: ...';

  async decideNextAction(): Promise<OrchestratorDecision> {
    return { action: 'wait_for_user', reason: 'test fallback', confidence: 1 };
  }

  async createRevisionInstructions(): Promise<AssistantTextResult> {
    return { markdown: 'Revise the plan using reviewer feedback and user-requested changes.', needsUserDecision: false };
  }

  async explainRevisedPlan(): Promise<AssistantTextResult> {
    return { markdown: 'Assistant explanation of the revised plan.', needsUserDecision: false };
  }

  async answerQuestion(input: { question: string }): Promise<string> {
    return `Answer: ${input.question}`;
  }

  async interpretAmbiguousReply(): Promise<string> {
    return this.fallbackReply;
  }

  async classifyIntent(): Promise<IntentResult> {
    return {
      intent: 'unknown',
      confidence: 0.4,
      requiresClarification: true,
      userFacingInterpretation: 'unclear',
    };
  }

  async composeReply(input: { rawMessage: string }): Promise<{ text: string }> {
    return { text: input.rawMessage };
  }

  async handleControlChat(input: { message: string; pendingProposal?: TaskProposal; mode: 'message' | 'edit' }): Promise<ControlChatResult> {
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
    return this.route;
  }
}

class FakeHeavyAgents implements HeavyAgentAdapter {
  reviewerRuns = 0;
  implementRuns = 0;
  finalReviewRuns = 0;
  difficultyCalls: WorkflowDifficulty[] = [];
  initialPlanProjectContexts: string[] = [];
  implementationProjectContexts: string[] = [];
  finalReviewResult: FinalReviewResult = { markdown: 'Final review passed.', passed: true };
  implementationMarkdown = 'Implementation completed by fake adapter.';
  implementationWritePath?: string;
  planPackDraft?: PlanResult['planPackDraft'];

  private makePromptRecord(input: { state?: { taskId?: string; difficulty?: WorkflowDifficulty }; difficulty?: WorkflowDifficulty }, role: WorkflowRoleName, prompt: string): AgentPromptRecord {
    return {
      taskId: input.state?.taskId ?? 'fake-task',
      role,
      difficulty: input.difficulty ?? input.state?.difficulty ?? 'medium',
      profileName: role === 'developer' ? 'implementer' : role === 'finalReviewer' ? 'finalReviewer' : role === 'planReviewer' ? 'reviewer' : 'planner',
      profileKind: role === 'finalReviewer' || role === 'planReviewer' ? 'claude' : 'codex',
      model: `${role}-model`,
      effort: `${role}-effort`,
      createdAt: '2026-05-22T00:00:00.000Z',
      prompt,
    };
  }

  async createInitialPlan(input: { difficulty: WorkflowDifficulty; projectContext: string; state: { taskId: string } }): Promise<PlanResult> {
    this.difficultyCalls.push(input.difficulty);
    this.initialPlanProjectContexts.push(input.projectContext);
    return {
      markdown: '# Initial Plan\n\n- Build the workflow.\n\n## Verification Commands\n- npm test',
      verificationCommands: ['npm test'],
      ...(this.planPackDraft ? { planPackDraft: this.planPackDraft } : {}),
      agentPrompt: this.makePromptRecord(input, 'architect', 'fake architect prompt'),
    };
  }

  async reviewPlan(input: { difficulty: WorkflowDifficulty; state: { taskId: string } }): Promise<{ markdown: string; agentPrompt: AgentPromptRecord }> {
    this.reviewerRuns += 1;
    this.difficultyCalls.push(input.difficulty);
    return {
      markdown: 'Reviewer says the plan should clarify artifact boundaries.',
      agentPrompt: this.makePromptRecord(input, 'planReviewer', 'fake plan reviewer prompt'),
    };
  }

  async revisePlan(input: { difficulty: WorkflowDifficulty; state: { taskId: string } }): Promise<PlanResult> {
    this.difficultyCalls.push(input.difficulty);
    return {
      markdown: '# Revised Plan\n\n- Build the workflow with explicit artifact boundaries.\n\n## Verification Commands\n- npm test\n- node unsafe.js',
      verificationCommands: ['npm test', 'node unsafe.js'],
      ...(this.planPackDraft ? { planPackDraft: this.planPackDraft } : {}),
      agentPrompt: this.makePromptRecord(input, 'architect', 'fake revised architect prompt'),
    };
  }

  async implement(input: { projectContext: string; state: { taskId: string; difficulty?: WorkflowDifficulty } }): Promise<{ markdown: string; changedFiles: string[]; agentPrompt: AgentPromptRecord }> {
    this.implementRuns += 1;
    this.implementationProjectContexts.push(input.projectContext);
    if (this.implementationWritePath) {
      await writeFile(this.implementationWritePath, 'implementation output\n', 'utf8');
    }
    return {
      markdown: this.implementationMarkdown,
      changedFiles: ['implementation.txt'],
      agentPrompt: this.makePromptRecord(input, 'developer', 'fake developer prompt'),
    };
  }

  async finalReview(input: { state: { taskId: string; difficulty?: WorkflowDifficulty } }): Promise<FinalReviewResult> {
    this.finalReviewRuns += 1;
    return {
      ...this.finalReviewResult,
      agentPrompt: this.makePromptRecord(input, 'finalReviewer', 'fake final reviewer prompt'),
    };
  }
}

async function makeGitRepo(): Promise<string> {
  const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
  await execFileAsync('git', ['init'], { cwd: targetDir });
  return targetDir;
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
    verification: {
      allowlist: ['npm test'],
    },
  };
}

function makeProjectConfig(targetDir: string): AssistantConfig {
  return {
    ...makeConfig(targetDir),
    defaultProjectId: 'ireader',
    projects: [{
      id: 'ireader',
      name: 'IReader',
      targetDir,
      docsDir: 'project-docs/ireader',
      alwaysRead: ['rules.md'],
    }],
  };
}

async function makeService(route?: AssistantRouteResult, options: { orchestratorEnabled?: boolean } = {}): Promise<{
  root: string;
  targetDir: string;
  store: ArtifactStore;
  service: WorkflowService;
  assistant: FakeAssistant;
  heavy: FakeHeavyAgents;
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
  const targetDir = await makeGitRepo();
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  if (route) assistant.route = route;
  const heavy = new FakeHeavyAgents();
  heavy.implementationWritePath = join(targetDir, 'implementation.txt');
  const service = new WorkflowService(store, config, assistant, heavy, { executeVerification: false, ...options });
  return { root, targetDir, store, service, assistant, heavy };
}

async function makeProjectService(): Promise<{
  root: string;
  targetDir: string;
  service: WorkflowService;
  assistant: FakeAssistant;
  heavy: FakeHeavyAgents;
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
  const targetDir = await makeGitRepo();
  const docsDir = join(root, 'project-docs', 'ireader');
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, 'rules.md'), '# Rules\nUse the contextual translation architecture.\n', 'utf8');
  await writeFile(join(docsDir, 'translation.md'), '# Translation Planner\nPlanner owns route summaries.\n', 'utf8');
  const config = makeProjectConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  const heavy = new FakeHeavyAgents();
  heavy.implementationWritePath = join(targetDir, 'implementation.txt');
  const service = new WorkflowService(store, config, assistant, heavy, { executeVerification: false });
  return { root, targetDir, service, assistant, heavy };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

async function planThroughDifficulty(service: WorkflowService, taskId: string, difficulty: WorkflowDifficulty = 'medium'): Promise<WorkflowResult> {
  const difficultyStop = await service.planTask(taskId);
  expect(difficultyStop.state.status).toBe('awaiting_difficulty_selection');
  expect(difficultyStop.state.pendingUserPrompt).toContain('low');
  expect(difficultyStop.state.pendingUserPrompt).toContain('medium');
  expect(difficultyStop.state.pendingUserPrompt).toContain('high');
  expect(difficultyStop.state.pendingUserPrompt).toContain('extra high');
  return service.reply(taskId, difficulty);
}

describe('WorkflowService', () => {
  it('runs create and plan through explanation while reviewing only once', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'Reader task', task: 'Build a feature.' });
      expect(created.state.projectId).toBe('default');
      const planned = await planThroughDifficulty(service, created.state.taskId);

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.reviewerRunCount).toBe(1);
      expect(heavy.reviewerRuns).toBe(1);
      expect(await service.showArtifact(planned.state.taskId, 'revised-plan')).toContain('assistant-plan-metadata');
      const prompts = await service.showArtifact(planned.state.taskId, 'agent-prompts');
      expect(prompts).toContain('fake architect prompt');
      expect(prompts).toContain('fake plan reviewer prompt');
      expect(prompts).toContain('fake revised architect prompt');
      expect(prompts).toContain('- Role: planReviewer');
      expect(prompts).toContain('- Model: planReviewer-model');
      expect(prompts).toContain('- Effort: planReviewer-effort');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts', async () => {
    const { root, targetDir, service, heavy } = await makeProjectService();
    try {
      const created = await service.createTask({
        title: 'Project memory task',
        task: 'Improve the translation planner.',
        projectId: 'ireader',
      });
      expect(created.state.projectId).toBe('ireader');

      const planned = await planThroughDifficulty(service, created.state.taskId);
      await service.reply(planned.state.taskId, 'approve A');

      expect(heavy.initialPlanProjectContexts[0]).toContain('rules.md#Rules');
      expect(heavy.initialPlanProjectContexts[0]).toContain('translation.md#Translation Planner');
      expect(heavy.implementationProjectContexts[0]).toContain('Project Context Packet');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('routes revise C back to planning and regenerates without another reviewer pass', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'Revise task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      const revised = await service.reply(planned.state.taskId, 'revise C: reduce MVP scope');

      expect(revised.state.status).toBe('ready_for_decision');
      expect(revised.state.requestedChanges).toContain('reduce MVP scope');
      expect(revised.state.reviewerRunCount).toBe(1);
      expect(heavy.reviewerRuns).toBe(1);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('approves, implements, final-reviews, and writes a final report with dirty sections', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.implementationMarkdown = [
        'Implementation completed by fake adapter.',
        `\u001b[36m${simulateUtf8ReadAsGbk('涓枃鏂囦欢璇诲彇')}\u001b[39m`,
      ].join('\n');
      await writeFile(join(targetDir, 'preexisting.txt'), 'dirty before implementation\n', 'utf8');
      const created = await service.createTask({ title: 'Approve task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      const approved = await service.reply(planned.state.taskId, 'A');

      expect(approved.state.status).toBe('awaiting_user_acceptance');
      const accepted = await service.reply(planned.state.taskId, 'accept');
      expect(accepted.state.status).toBe('completed');
      const report = await service.showArtifact(accepted.state.taskId, 'final-report');
      expect(report).toContain('## 本次 implementation 产生的 diff');
      expect(report).toContain('Implementation completed by fake adapter.');
      expect(report).not.toContain('\u001b[');
      expect(report).toContain('implementation.txt');
      expect(report).toContain('## pre-existing dirty');
      expect(report).toContain('preexisting.txt');
      expect(await service.showArtifact(accepted.state.taskId, 'test-build-log')).toContain('node unsafe.js');
      expect(await service.showArtifact(accepted.state.taskId, 'test-build-log')).toContain('blocked');
      const prompts = await service.showArtifact(accepted.state.taskId, 'agent-prompts');
      expect(prompts).toContain('fake developer prompt');
      expect(prompts).toContain('fake final reviewer prompt');
      expect(prompts).toContain('- Role: developer');
      expect(prompts).toContain('- Role: finalReviewer');
      const taskRecord = await readFile(join(targetDir, 'task', accepted.state.taskId, 'task-record.md'), 'utf8');
      expect(taskRecord).toContain('Implementation completed by fake adapter.');
      expect(taskRecord).not.toContain('\u001b[');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('clears pendingUserPrompt when the user requests revision after final review', async () => {
    const { root, targetDir, service, store } = await makeService();
    try {
      const created = await service.createTask({ title: 'Acceptance revision task', task: 'Ship it.' });
      let state = await store.writeArtifact(created.state, 'implementation-log', 'implemented');
      state = await store.writeArtifact(state, 'test-build-log', 'tests passed');
      state = await store.writeArtifact(state, 'final-review', 'final passed');
      state = {
        ...state,
        status: 'awaiting_user_acceptance',
        pendingUserPrompt: "Waiting for acceptance: reply 'accept' to finalize the task record.",
        updatedAt: new Date().toISOString(),
      };
      await store.saveState(state);

      const revised = await service.reply(state.taskId, 'revise C: polish the final copy');

      expect(revised.state.status).toBe('implementation_approved');
      expect(revised.state.pendingUserPrompt).toBeUndefined();
      expect((await store.loadState(state.taskId)).pendingUserPrompt).toBeUndefined();
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.planPackDraft = {
        category: 'Assistant / Workflow',
        summary: 'Add universal task record storage.',
        executionUnits: [
          { name: 'Task record storage' },
          { name: 'Acceptance workflow' },
        ],
      };
      const created = await service.createTask({ title: 'Task records', task: 'Add universal task records.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      const approved = await service.reply(planned.state.taskId, 'approve A');

      expect(approved.state.status).toBe('awaiting_user_acceptance');
      expect(approved.state.category).toBe('Assistant / Workflow');
      expect(approved.state.executionMode).toBe('decomposed');
      expect(approved.state.executionQueue.map((unit) => unit.status)).toEqual(['Done', 'Done']);
      expect(heavy.implementRuns).toBe(2);
      expect(heavy.finalReviewRuns).toBe(1);

      const parentDir = join(targetDir, 'task', approved.state.taskId);
      await expect(readFile(join(parentDir, 'plan.md'), 'utf8')).resolves.toContain('Build the workflow');
      await expect(readFile(join(parentDir, 'plan-review.md'), 'utf8')).resolves.toContain('Reviewer says');
      await expect(readFile(join(parentDir, 'subtasks', '01-task-record-storage.md'), 'utf8')).resolves.toContain('## Test Result');
      await expect(readFile(join(parentDir, 'task-record.md'), 'utf8')).resolves.toContain('Pending');

      const noted = await service.reply(approved.state.taskId, 'note: looks good after smoke testing');
      expect(noted.state.status).toBe('awaiting_user_acceptance');
      expect(noted.state.userAcceptanceNotes).toContain('looks good after smoke testing');

      const accepted = await service.reply(approved.state.taskId, 'accept');
      expect(accepted.state.status).toBe('completed');
      const taskRecord = await readFile(join(parentDir, 'task-record.md'), 'utf8');
      expect(taskRecord).toContain('# Task Record: Task records');
      expect(taskRecord).toContain('Accepted at');
      expect(taskRecord).toContain('looks good after smoke testing');
      const globalReadme = await readFile(join(targetDir, 'task', 'README.md'), 'utf8');
      expect(globalReadme).toContain('| Task | Category | Status | Execution Mode | Summary | Updated |');
      expect(globalReadme).toContain('Assistant / Workflow');
      expect(globalReadme).toContain('completed');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it.each([
    [{ route: 'route_to_implementer', reason: 'Contained bug remains.' } as AssistantRouteResult, 'implementation_approved'],
    [{ route: 'route_to_planner', reason: 'The plan missed a design constraint.' } as AssistantRouteResult, 'ready_for_decision'],
    [{ route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' } as AssistantRouteResult, 'waiting_user_direction'],
  ])('routes after failed final review through %s', async (route, expectedStatus) => {
    const { root, targetDir, service } = await makeService(route);
    try {
      const created = await service.createTask({ title: 'Route task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      const approved = await service.reply(planned.state.taskId, 'approve A');

      expect(approved.state.status).toBe(expectedStatus);
      if (route.route === 'route_to_implementer') {
        expect(approved.message).toContain(route.reason);
        expect(approved.state.requestedChanges).toContain(`Final review requested implementation follow-up:\n${route.reason}`);
        expect(approved.state.pendingUserPrompt).toContain('approve A');
      }
      if (route.route === 'route_to_planner') {
        expect(approved.state.requestedChanges).toContain(`Final review requested planning follow-up:\n${route.reason}`);
        expect(approved.state.pendingUserPrompt).toBeUndefined();
        expect(approved.message).toContain('Revised plan is ready');
      }
      if (route.route === 'ask_user_direction') {
        expect(approved.message).toContain(route.reason);
        expect(approved.state.pendingUserPrompt).toContain('产品/范围问题');
        expect(approved.state.pendingUserPrompt).toContain(route.userPrompt);
      }
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('can restart a stopped task from planning with a new prompt', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Restart task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      expect(planned.state.status).toBe('ready_for_decision');

      const stopped = await service.reply(planned.state.taskId, 'stop');
      expect(stopped.state.status).toBe('stopped');

      const restartPrompt = await service.reply(
        stopped.state.taskId,
        'restart: redesign the verification around production runtime calls',
      );
      expect(restartPrompt.state.status).toBe('ready_for_decision');
      expect(restartPrompt.state.revisionRound).toBe(1);
      expect(restartPrompt.state.reviewerRunCount).toBe(1);
      expect(restartPrompt.state.stoppedReason).toBeUndefined();
      expect(restartPrompt.state.requestedChanges).toContain(
        'Restart/redesign prompt:\nredesign the verification around production runtime calls',
      );
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('does not allow state-machine jumps', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Guard task', task: 'Build a feature.' });
      await expect(service.implementApproved(created.state.taskId)).rejects.toThrow('Cannot implement before approval');
      await expect(service.explainTask(created.state.taskId)).rejects.toThrow('Cannot explain before a revised plan exists');
      await expect(service.finalReview(created.state.taskId)).rejects.toThrow('Cannot run final review before implementation');
      await expect(service.reply(created.state.taskId, 'approve A')).rejects.toThrow('Cannot approve implementation');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('uses LLM fallback confirmation for non-whitelisted replies without executing them', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Fallback task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      const fallback = await service.reply(planned.state.taskId, '濂界殑');

      expect(fallback.state.status).toBe('ready_for_decision');
      expect(fallback.message).toContain('Please reply');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('pauses at awaiting_difficulty_selection before invoking heavy agents', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'Difficulty gate task', task: 'Voice input task.' });
      const difficultyStop = await service.planTask(created.state.taskId);

      expect(difficultyStop.state.status).toBe('awaiting_difficulty_selection');
      expect(difficultyStop.state.pendingUserPrompt).toContain('low');
      expect(difficultyStop.state.pendingUserPrompt).toContain('medium');
      expect(difficultyStop.state.pendingUserPrompt).toContain('high');
      expect(difficultyStop.state.pendingUserPrompt).toContain('extra high');
      expect(difficultyStop.state.revisionRound).toBe(0);
      expect(heavy.difficultyCalls).toHaveLength(0);
      expect(heavy.reviewerRuns).toBe(0);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('chooses difficulty from the first user gate and starts planning', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'Difficulty gate task', task: 'Build a feature.' });
      await service.planTask(created.state.taskId);
      const planned = await service.reply(created.state.taskId, 'medium');

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.difficulty).toBe('medium');
      expect(planned.state.pendingUserPrompt).toBeUndefined();
      expect(heavy.difficultyCalls).toEqual(['medium', 'medium', 'medium']);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it.each([
    ['extra high', []],
    ['Extra-High', []],
    ['EXTRA_HIGH: keep the original prompt', ['keep the original prompt']],
  ])('canonicalizes %s to extra-high difficulty', async (reply, expectedChanges) => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Extra high task', task: 'Build a careful feature.' });
      await service.planTask(created.state.taskId);
      const planned = await service.reply(created.state.taskId, reply);

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.difficulty).toBe('extra-high');
      expect(planned.state.requestedChanges).toEqual(expectedChanges);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('skips plan review and revision in low difficulty', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'Low task', task: 'Adjust copy.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'low');

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.difficulty).toBe('low');
      expect(planned.state.reviewerRunCount).toBe(0);
      expect(heavy.reviewerRuns).toBe(0);
      expect(heavy.difficultyCalls).toEqual(['low']);

      const initialPlan = await service.showArtifact(planned.state.taskId, 'initial-plan');
      const revisedPlan = await service.showArtifact(planned.state.taskId, 'revised-plan');
    expect(revisedPlan.replace(/\n\n<!-- assistant-plan-metadata[\s\S]*$/, '')).toBe(initialPlan);
    expect(revisedPlan).toContain('assistant-plan-metadata');
      await expect(service.showArtifact(planned.state.taskId, 'review')).rejects.toThrow();
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('passes high difficulty through every full planning agent call', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'High task', task: 'Build a risky feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'high');

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.difficulty).toBe('high');
      expect(planned.state.reviewerRunCount).toBe(1);
      expect(heavy.reviewerRuns).toBe(1);
      expect(heavy.difficultyCalls).toEqual(['high', 'high', 'high']);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('stops from the difficulty gate', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Difficulty stop task', task: 'Task body.' });
      await service.planTask(created.state.taskId);
      const stopped = await service.reply(created.state.taskId, 'stop');

      expect(stopped.state.status).toBe('stopped');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('defaults heavy agents to stubs unless agent calls are explicitly enabled', () => {
    expect(createHeavyAgentAdapter(makeConfig(process.cwd()), false).constructor.name).toBe('StubHeavyAgentAdapter');
    expect(createHeavyAgentAdapter(makeConfig(process.cwd()), true).constructor.name).not.toBe('StubHeavyAgentAdapter');
  });
});
