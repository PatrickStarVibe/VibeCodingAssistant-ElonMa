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
  AssistantTextResult,
  ControlChatResult,
  FinalReviewResult,
  IntentResult,
  AssistantConfig,
  AssistantRouteResult,
  OrchestratorDecision,
  PendingUserDecision,
  PlanResult,
  ReviewResult,
  TaskProposal,
  WorkflowDifficulty,
  WorkflowRoleName,
} from '../src/types.js';
import { createHeavyAgentAdapter } from '../src/adapters.js';
import { WorkflowService, isReviewerApproval, type WorkflowResult } from '../src/workflow.js';

const execFileAsync = promisify(execFile);
const gb18030Decoder = new TextDecoder('gb18030');
const utf8Encoder = new TextEncoder();

function simulateUtf8ReadAsGbk(value: string): string {
  return gb18030Decoder.decode(utf8Encoder.encode(value));
}

function makePendingDecision(overrides: Partial<PendingUserDecision> = {}): PendingUserDecision {
  return {
    id: 'decision:test',
    source: 'final_review',
    question: 'Choose MVP or full scope.',
    rationale: 'The final review found a product scope tradeoff that cannot be decided safely by the workflow.',
    options: [
      { id: 'A', label: 'Ship the MVP scope', impact: 'Keeps the task narrow and avoids adding unrequested behavior.' },
      { id: 'B', label: 'Expand to full scope', impact: 'Takes longer but covers the larger product expectation now.' },
    ],
    recommendedOptionId: 'A',
    recommendationReason: 'The advisor recommends the MVP because it matches the original task boundary.',
    allowFreeform: true,
    ...overrides,
  };
}

function noReviewerBlockers(): NonNullable<ReviewResult['reviewerBlockerOutput']> {
  return { blockers: [], previousVerdicts: [] };
}

function reviewerIntroducesB1(overrides: Partial<NonNullable<ReviewResult['reviewerBlockerOutput']>['blockers'][number]> = {}): NonNullable<ReviewResult['reviewerBlockerOutput']> {
  return {
    blockers: [{
      id: 'B1',
      severity: 'blocker',
      category: 'test',
      title: 'Verification missing',
      detail: 'The plan does not define focused tests or build verification.',
      verifyHint: 'Architect should add a Tests or Verification section with concrete commands.',
      ...overrides,
    }],
    previousVerdicts: [],
  };
}

function reviewerVerdictsB1(
  verdict: 'closed' | 'still_open' | 'changed',
  reason: string,
  changed?: Partial<NonNullable<ReviewResult['reviewerBlockerOutput']>['blockers'][number]>,
): NonNullable<ReviewResult['reviewerBlockerOutput']> {
  return {
    blockers: verdict === 'changed'
      ? [{
          id: 'B1',
          severity: 'high',
          category: 'test',
          title: 'Verification still incomplete',
          detail: 'The revised plan names tests but does not say how to run them safely.',
          verifyHint: 'Architect should anchor exact verification commands in the revised plan.',
          ...changed,
        }]
      : [],
    previousVerdicts: [{ id: 'B1', verdict, reason }],
  };
}

function architectRespondsB1(overrides: Partial<NonNullable<PlanResult['architectBlockerResponses']>[number]> = {}): NonNullable<PlanResult['architectBlockerResponses']> {
  return [{
    id: 'B1',
    status: 'addressed',
    summary: 'Added explicit verification commands and scoped test coverage.',
    planAnchor: '## Verification Commands',
    ...overrides,
  }];
}

class FakeAssistant implements AssistantAdapter {
  route: AssistantRouteResult = { route: 'complete', reason: 'No blocking issues.' };
  fallbackReply = 'Please reply with approve A, reject B, or revise C: ...';
  createRevisionInstructionsRuns = 0;
  revisionInstructionsMarkdown = 'Revise the plan using reviewer feedback and user-requested changes.';
  revisionInstructionsResult?: AssistantTextResult;
  explanationResult?: AssistantTextResult;

  async decideNextAction(): Promise<OrchestratorDecision> {
    return { action: 'wait_for_user', reason: 'test fallback', confidence: 1 };
  }

  async createRevisionInstructions(): Promise<AssistantTextResult> {
    this.createRevisionInstructionsRuns += 1;
    if (this.revisionInstructionsResult) return this.revisionInstructionsResult;
    return { markdown: this.revisionInstructionsMarkdown, needsUserDecision: false };
  }

  async explainRevisedPlan(): Promise<AssistantTextResult> {
    if (this.explanationResult) return this.explanationResult;
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
  createInitialPlanRuns = 0;
  reviewerRuns = 0;
  revisePlanRuns = 0;
  implementRuns = 0;
  finalReviewRuns = 0;
  difficultyCalls: WorkflowDifficulty[] = [];
  initialPlanProjectContexts: string[] = [];
  implementationProjectContexts: string[] = [];
  implementInputs: Array<{
    mode?: string;
    executionUnitName?: string;
    finalReviewReason?: string;
    priorImplementationLog?: string;
    priorVerificationLog?: string;
  }> = [];
  finalReviewResult: FinalReviewResult = { markdown: 'Final review passed.', passed: true };
  implementationMarkdown = 'Implementation completed by fake adapter.';
  implementationWritePath?: string;
  planPackDraft?: PlanResult['planPackDraft'];
  initialPlanResults: Array<Pick<PlanResult, 'markdown'> & Partial<Omit<PlanResult, 'markdown'>>> = [];
  revisedPlanResults: Array<Pick<PlanResult, 'markdown'> & Partial<Omit<PlanResult, 'markdown'>>> = [];
  reviewResults: Array<Pick<ReviewResult, 'markdown'> & Partial<Omit<ReviewResult, 'markdown'>>> = [];
  reviewMarkdowns: string[] = [];
  reviewPlanInputs: Array<{ blockerLedgerText?: string }> = [];
  revisePlanInputs: Array<{ initialPlan?: string; review?: string; requestedChanges?: string[]; blockerLedgerText?: string }> = [];

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
    const fixture = this.initialPlanResults[this.createInitialPlanRuns];
    this.createInitialPlanRuns += 1;
    this.difficultyCalls.push(input.difficulty);
    this.initialPlanProjectContexts.push(input.projectContext);
    const planPackDraft = fixture?.planPackDraft ?? this.planPackDraft;
    return {
      markdown: fixture?.markdown ?? '# Initial Plan\n\n- Build the workflow.\n\n## Verification Commands\n- npm test',
      verificationCommands: fixture?.verificationCommands ?? ['npm test'],
      ...(planPackDraft ? { planPackDraft } : {}),
      agentPrompt: fixture?.agentPrompt ?? this.makePromptRecord(input, 'architect', 'fake architect prompt'),
      ...(fixture?.sourcePath ? { sourcePath: fixture.sourcePath } : {}),
      ...(fixture?.stdoutSummary ? { stdoutSummary: fixture.stdoutSummary } : {}),
      ...(fixture?.userDecision ? { userDecision: fixture.userDecision } : {}),
      ...(fixture?.decisionParseError ? { decisionParseError: fixture.decisionParseError } : {}),
    };
  }

  async reviewPlan(input: { difficulty: WorkflowDifficulty; state: { taskId: string }; blockerLedgerText?: string }): Promise<ReviewResult> {
    const fixture = this.reviewResults[this.reviewerRuns];
    const markdown = fixture?.markdown ?? this.reviewMarkdowns[this.reviewerRuns] ?? 'Reviewer says the plan should clarify artifact boundaries.';
    this.reviewerRuns += 1;
    this.difficultyCalls.push(input.difficulty);
    this.reviewPlanInputs.push({ blockerLedgerText: input.blockerLedgerText });
    const defaultLedger = !fixture && (input.difficulty === 'high' || input.difficulty === 'extra-high')
      ? noReviewerBlockers()
      : undefined;
    return {
      markdown,
      agentPrompt: fixture?.agentPrompt ?? this.makePromptRecord(input, 'planReviewer', 'fake plan reviewer prompt'),
      ...(fixture?.sourcePath ? { sourcePath: fixture.sourcePath } : {}),
      ...(fixture?.stdoutSummary ? { stdoutSummary: fixture.stdoutSummary } : {}),
      ...(fixture?.userDecision ? { userDecision: fixture.userDecision } : {}),
      ...(fixture?.decisionParseError ? { decisionParseError: fixture.decisionParseError } : {}),
      ...(fixture?.reviewerBlockerOutput ? { reviewerBlockerOutput: fixture.reviewerBlockerOutput } : {}),
      ...(fixture?.blockerLedgerParseError ? { blockerLedgerParseError: fixture.blockerLedgerParseError } : {}),
      ...(defaultLedger ? { reviewerBlockerOutput: defaultLedger } : {}),
    };
  }

  async revisePlan(input: { difficulty: WorkflowDifficulty; state: { taskId: string }; initialPlan?: string; review?: string; requestedChanges?: string[]; blockerLedgerText?: string }): Promise<PlanResult> {
    const fixture = this.revisedPlanResults[this.revisePlanRuns];
    this.revisePlanRuns += 1;
    this.difficultyCalls.push(input.difficulty);
    this.revisePlanInputs.push({
      initialPlan: input.initialPlan,
      review: input.review,
      requestedChanges: input.requestedChanges,
      blockerLedgerText: input.blockerLedgerText,
    });
    const planPackDraft = fixture?.planPackDraft ?? this.planPackDraft;
    return {
      markdown: fixture?.markdown ?? '# Revised Plan\n\n- Build the workflow with explicit artifact boundaries.\n\n## Verification Commands\n- npm test\n- node unsafe.js',
      verificationCommands: fixture?.verificationCommands ?? ['npm test', 'node unsafe.js'],
      ...(planPackDraft ? { planPackDraft } : {}),
      agentPrompt: fixture?.agentPrompt ?? this.makePromptRecord(input, 'architect', 'fake revised architect prompt'),
      ...(fixture?.sourcePath ? { sourcePath: fixture.sourcePath } : {}),
      ...(fixture?.stdoutSummary ? { stdoutSummary: fixture.stdoutSummary } : {}),
      ...(fixture?.userDecision ? { userDecision: fixture.userDecision } : {}),
      ...(fixture?.decisionParseError ? { decisionParseError: fixture.decisionParseError } : {}),
      ...(fixture?.architectBlockerResponses ? { architectBlockerResponses: fixture.architectBlockerResponses } : {}),
      ...(fixture?.blockerResponseParseError ? { blockerResponseParseError: fixture.blockerResponseParseError } : {}),
    };
  }

  async implement(input: {
    projectContext: string;
    state: { taskId: string; difficulty?: WorkflowDifficulty };
    mode?: string;
    executionUnit?: { name: string };
    finalReviewReason?: string;
    priorImplementationLog?: string;
    priorVerificationLog?: string;
  }): Promise<{ markdown: string; changedFiles: string[]; agentPrompt: AgentPromptRecord }> {
    this.implementRuns += 1;
    this.implementationProjectContexts.push(input.projectContext);
    this.implementInputs.push({
      mode: input.mode,
      executionUnitName: input.executionUnit?.name,
      finalReviewReason: input.finalReviewReason,
      priorImplementationLog: input.priorImplementationLog,
      priorVerificationLog: input.priorVerificationLog,
    });
    if (this.implementationWritePath) {
      await writeFile(this.implementationWritePath, `${input.mode ?? 'full_plan'} implementation output ${this.implementRuns}\n`, 'utf8');
    }
    return {
      markdown: input.mode === 'final_review_followup'
        ? `Follow-up implementation completed.\n\n${this.implementationMarkdown}`
        : this.implementationMarkdown,
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
    [{
      route: 'ask_user_direction',
      reason: 'Scope choice needed.',
      userPrompt: 'Choose MVP or full scope.',
      userDecision: makePendingDecision({ rationale: 'Scope choice needed.' }),
    } as AssistantRouteResult, 'waiting_user_direction'],
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
        expect(approved.state.implementationFollowup).toMatchObject({
          source: 'final_review',
          round: 1,
          reason: route.reason,
        });
        expect(approved.state.pendingUserPrompt).toContain('approve A');
      }
      if (route.route === 'route_to_planner') {
        expect(approved.state.requestedChanges).toContain(`Final review requested planning follow-up:\n${route.reason}`);
        expect(approved.state.pendingUserPrompt).toBeUndefined();
        expect(approved.message).toContain('Revised plan is ready');
      }
      if (route.route === 'ask_user_direction') {
        expect(approved.message).toContain(route.reason);
        expect(approved.state.pendingUserPrompt).toContain('A. Ship the MVP scope');
        expect(approved.state.pendingUserPrompt).toContain('推荐理由');
        expect(approved.state.pendingUserPrompt).toContain(route.userPrompt);
        expect(approved.state.pendingUserDecision).toEqual(route.userDecision);
      }
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('runs only one scoped follow-up unit after final review routes to implementer', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService({
      route: 'route_to_implementer',
      reason: 'Fix the --env-file CLI handling defect.',
    });
    try {
      heavy.planPackDraft = {
        category: 'Assistant / Workflow',
        summary: 'Build distribution tooling.',
        executionUnits: [
          { name: 'Preflight checker' },
          { name: 'Setup wizard' },
          { name: 'Docs update' },
        ],
      };
      const created = await service.createTask({ title: 'Scoped followup task', task: 'Build tooling.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      const failedReview = await service.reply(planned.state.taskId, 'approve A');

      expect(failedReview.state.status).toBe('implementation_approved');
      expect(heavy.implementRuns).toBe(3);
      expect(failedReview.state.executionQueue.map((unit) => unit.status)).toEqual(['Done', 'Done', 'Done']);
      expect(failedReview.state.implementationFollowup).toMatchObject({
        source: 'final_review',
        round: 1,
        reason: 'Fix the --env-file CLI handling defect.',
      });

      assistant.route = { route: 'complete', reason: 'Follow-up fixed the defect.' };
      const followedUp = await service.reply(failedReview.state.taskId, 'approve A');

      expect(followedUp.state.status).toBe('awaiting_user_acceptance');
      expect(heavy.implementRuns).toBe(4);
      expect(heavy.implementInputs.at(-1)).toMatchObject({
        mode: 'final_review_followup',
        executionUnitName: 'Final Review Follow-up (round 1)',
        finalReviewReason: 'Fix the --env-file CLI handling defect.',
      });
      expect(heavy.implementInputs.at(-1)?.priorImplementationLog).toContain('Execution Unit 01');
      expect(heavy.implementInputs.at(-1)?.priorVerificationLog).toContain('Execution Unit 01');
      expect(followedUp.state.executionQueue.map((unit) => unit.name)).toEqual([
        'Preflight checker',
        'Setup wizard',
        'Docs update',
      ]);
      expect(followedUp.state.executionQueue.map((unit) => unit.status)).toEqual(['Done', 'Done', 'Done']);
      expect(followedUp.state.implementationFollowup).toBeUndefined();
      expect(followedUp.state.implementationFollowupHistory).toEqual([expect.objectContaining({
        round: 1,
        reason: 'Fix the --env-file CLI handling defect.',
      })]);
      await expect(service.showArtifact(followedUp.state.taskId, 'implementation-log')).resolves.toContain('## Final Review Follow-up (round 1)');
      await expect(service.showArtifact(followedUp.state.taskId, 'test-build-log')).resolves.toContain('# Final Review Follow-up (round 1)');
      await expect(service.showArtifact(followedUp.state.taskId, 'followup-git-pre-status')).resolves.toBeDefined();
      await expect(service.showArtifact(followedUp.state.taskId, 'followup-git-post-status')).resolves.toBeDefined();
      await expect(readFile(join(targetDir, 'task', followedUp.state.taskId, 'subtasks', '04-final-review-followup.md'), 'utf8')).rejects.toThrow();

      const accepted = await service.reply(followedUp.state.taskId, 'accept');
      expect(accepted.state.status).toBe('completed');
      await expect(service.showArtifact(accepted.state.taskId, 'final-report')).resolves.toContain('Final Review Follow-up');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('pauses after a repeated final-review implementer route and lets the user defer or stop', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService({
      route: 'route_to_implementer',
      reason: 'First contained defect.',
    });
    try {
      const created = await service.createTask({ title: 'Followup cap task', task: 'Build tooling.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      const failedReview = await service.reply(planned.state.taskId, 'approve A');
      expect(failedReview.state.status).toBe('implementation_approved');

      assistant.route = { route: 'route_to_implementer', reason: 'Still broken after follow-up.' };
      const capped = await service.reply(failedReview.state.taskId, 'approve A');

      expect(capped.state.status).toBe('waiting_user_direction');
      expect(capped.state.pendingUserDecision?.id).toContain('final-review-followup-cap');
      expect(capped.state.pendingUserDecision?.options.map((option) => option.label)).toEqual([
        'Run another follow-up',
        'Accept with deferred issues',
        'Stop task',
      ]);
      expect(heavy.implementRuns).toBe(2);

      const deferred = await service.answerUserDirection(capped.state.taskId, 'B');
      expect(deferred.state.status).toBe('awaiting_user_acceptance');
      expect(deferred.state.implementationFollowup).toBeUndefined();
      await expect(service.showArtifact(deferred.state.taskId, 'deferred-issues')).resolves.toContain('Still broken after follow-up.');

      const accepted = await service.reply(deferred.state.taskId, 'accept');
      expect(accepted.state.status).toBe('completed');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('can run an explicitly approved second final-review follow-up after the cap pause', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService({
      route: 'route_to_implementer',
      reason: 'First contained defect.',
    });
    try {
      const created = await service.createTask({ title: 'Second followup task', task: 'Build tooling.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      const failedReview = await service.reply(planned.state.taskId, 'approve A');
      assistant.route = { route: 'route_to_implementer', reason: 'Still broken after follow-up.' };
      const capped = await service.reply(failedReview.state.taskId, 'approve A');

      const retryReady = await service.answerUserDirection(capped.state.taskId, 'A');
      expect(retryReady.state.status).toBe('implementation_approved');
      expect(retryReady.state.implementationFollowup).toMatchObject({
        round: 2,
        reason: 'Still broken after follow-up.',
      });

      assistant.route = { route: 'complete', reason: 'Second follow-up fixed it.' };
      const complete = await service.reply(retryReady.state.taskId, 'approve A');
      expect(complete.state.status).toBe('awaiting_user_acceptance');
      expect(heavy.implementRuns).toBe(3);
      expect(heavy.implementInputs.at(-1)).toMatchObject({
        mode: 'final_review_followup',
        executionUnitName: 'Final Review Follow-up (round 2)',
      });
      expect(complete.state.implementationFollowupHistory?.map((entry) => entry.round)).toEqual([1, 2]);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('clears active final-review follow-up scope when the user stops', async () => {
    const { root, targetDir, service } = await makeService({
      route: 'route_to_implementer',
      reason: 'Contained bug remains.',
    });
    try {
      const created = await service.createTask({ title: 'Stop followup task', task: 'Build tooling.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);
      const failedReview = await service.reply(planned.state.taskId, 'approve A');
      expect(failedReview.state.implementationFollowup).toBeTruthy();

      const stopped = await service.reply(failedReview.state.taskId, 'stop');
      expect(stopped.state.status).toBe('stopped');
      expect(stopped.state.implementationFollowup).toBeUndefined();
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('pauses safely when Architect asks for a decision without a valid structured block', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [{
        markdown: 'NEEDS_USER_DECISION: choose MVP or full scope.',
        verificationCommands: [],
        decisionParseError: 'user decision marker present without assistant-user-decision block',
      }];

      const created = await service.createTask({ title: 'Invalid decision task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);

      expect(planned.state.status).toBe('waiting_user_direction');
      expect(planned.state.pendingUserDecision).toBeUndefined();
      expect(planned.state.pendingUserPrompt).toContain('Architect output is invalid');
      expect(planned.state.pendingUserPrompt).toContain('assistant-user-decision block');
      expect(heavy.reviewerRuns).toBe(0);
      expect(heavy.revisePlanRuns).toBe(0);
      await expect(service.showArtifact(planned.state.taskId, 'decision-log')).resolves.toContain('invalid user decision output');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('renders structured Architect decisions with recommendation details', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [{
        markdown: '# Initial Plan\n\nNeeds product direction.',
        verificationCommands: [],
        userDecision: makePendingDecision({
          source: 'architect_plan',
          question: 'Should the first pass include analytics?',
          rationale: 'Analytics changes the scope and verification strategy.',
          options: [
            { id: 'A', label: 'Skip analytics for now', impact: 'Keeps the first pass focused on the requested workflow.' },
            { id: 'B', label: 'Include analytics now', impact: 'Broadens scope and adds more verification work.' },
          ],
          recommendedOptionId: 'A',
          recommendationReason: 'The Architect recommends A because analytics was not in the original request.',
        }),
      }];

      const created = await service.createTask({ title: 'Structured decision task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);

      expect(planned.state.status).toBe('waiting_user_direction');
      expect(planned.message).toContain('Should the first pass include analytics?');
      expect(planned.message).toContain('A. Skip analytics for now');
      expect(planned.message).toContain('The Architect recommends A');
      expect(planned.state.pendingUserDecision?.source).toBe('architect_plan');
      expect(heavy.reviewerRuns).toBe(0);
      expect(heavy.revisePlanRuns).toBe(0);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('records Architect decision answers raw and resumes plan and review', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [
        {
          markdown: '# Initial Plan\n\nNeeds product direction.',
          verificationCommands: [],
          userDecision: makePendingDecision({
            source: 'architect_plan',
            question: 'Should the first pass include analytics?',
            rationale: 'Analytics changes the scope and verification strategy.',
          }),
        },
        {
          markdown: '# Initial Plan\n\n- Build with the selected direction.\n\n## Verification Commands\n- npm test',
          verificationCommands: ['npm test'],
        },
      ];

      const created = await service.createTask({ title: 'Decision answer task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);

      const answered = await service.answerUserDirection(planned.state.taskId, 'A');

      expect(answered.state.status).toBe('ready_for_decision');
      expect(heavy.createInitialPlanRuns).toBe(2);
      expect(heavy.reviewerRuns).toBe(1);
      expect(heavy.revisePlanRuns).toBe(1);
      expect(answered.state.requestedChanges.join('\n')).toContain('User direction (raw, do not rewrite):\nA');
      expect(answered.state.requestedChanges.join('\n')).toContain('Selected option: A. Ship the MVP scope');
      await expect(service.showArtifact(answered.state.taskId, 'decision-log')).resolves.toContain('selected option: A. Ship the MVP scope');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('pauses on Reviewer decisions and resumes through plan review and revise after the answer', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [
        { markdown: '# Initial Plan\n\n- First pass.\n\n## Verification Commands\n- npm test', verificationCommands: ['npm test'] },
        { markdown: '# Initial Plan\n\n- Direction applied.\n\n## Verification Commands\n- npm test', verificationCommands: ['npm test'] },
      ];
      heavy.reviewResults = [
        {
          markdown: '# Review\n\nNeed product direction.',
          userDecision: makePendingDecision({
            source: 'plan_review',
            question: 'Should the plan preserve legacy behavior?',
            rationale: 'The reviewer found a product compatibility tradeoff.',
          }),
        },
        { markdown: 'No blocking issues after user direction.' },
      ];

      const created = await service.createTask({ title: 'Reviewer decision task', task: 'Build a feature.' });
      const paused = await planThroughDifficulty(service, created.state.taskId);

      expect(paused.state.status).toBe('waiting_user_direction');
      expect(paused.state.pendingUserDecision?.source).toBe('plan_review');
      expect(heavy.revisePlanRuns).toBe(0);

      const answered = await service.answerUserDirection(paused.state.taskId, 'A');

      expect(answered.state.status).toBe('ready_for_decision');
      expect(heavy.createInitialPlanRuns).toBe(2);
      expect(heavy.reviewerRuns).toBe(2);
      expect(heavy.revisePlanRuns).toBe(1);
      expect(heavy.revisePlanInputs[0]?.review).toContain('No blocking issues after user direction.');
      expect(heavy.revisePlanInputs[0]?.requestedChanges?.join('\n')).toContain('User direction (raw, do not rewrite):\nA');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('pauses on revised Architect decisions and resumes planning after the answer', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [
        { markdown: '# Initial Plan\n\n- First pass.\n\n## Verification Commands\n- npm test', verificationCommands: ['npm test'] },
        { markdown: '# Initial Plan\n\n- Direction applied.\n\n## Verification Commands\n- npm test', verificationCommands: ['npm test'] },
      ];
      heavy.reviewMarkdowns = [
        'Reviewer says the plan needs a compatibility decision.',
        'No blocking issues after user direction.',
      ];
      heavy.revisedPlanResults = [
        {
          markdown: '# Revised Plan\n\nNeed compatibility direction.',
          verificationCommands: [],
          userDecision: makePendingDecision({
            source: 'architect_plan',
            question: 'Should compatibility mode be included now?',
            rationale: 'The revised plan found a scope tradeoff.',
          }),
        },
        { markdown: '# Revised Plan\n\n- Compatibility direction applied.', verificationCommands: ['npm test'] },
      ];

      const created = await service.createTask({ title: 'Revised decision task', task: 'Build a feature.' });
      const paused = await planThroughDifficulty(service, created.state.taskId);

      expect(paused.state.status).toBe('waiting_user_direction');
      expect(paused.state.pendingUserDecision?.source).toBe('architect_plan');
      expect(heavy.revisePlanRuns).toBe(1);

      const answered = await service.answerUserDirection(paused.state.taskId, 'A');

      expect(answered.state.status).toBe('ready_for_decision');
      expect(heavy.createInitialPlanRuns).toBe(2);
      expect(heavy.reviewerRuns).toBe(2);
      expect(heavy.revisePlanRuns).toBe(2);
      const revisedPlan = await service.showArtifact(answered.state.taskId, 'revised-plan');
      expect(revisedPlan).toContain('Compatibility direction applied.');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('does not let Assistant explanations block planning with user decisions', async () => {
    const { root, targetDir, service, assistant } = await makeService();
    try {
      assistant.explanationResult = {
        markdown: 'Assistant explanation asks a follow-up, but it is informational only.',
        needsUserDecision: true,
        userDecision: makePendingDecision({ source: 'plan_explanation' }),
      };

      const created = await service.createTask({ title: 'Explanation gate task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.pendingUserDecision).toBeUndefined();
      const explanation = await service.showArtifact(planned.state.taskId, 'assistant-explanation');
      expect(explanation).toContain('informational only');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('preserves free-form decision answers without rewriting them', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [
        {
          markdown: '# Initial Plan\n\nNeeds product direction.',
          verificationCommands: [],
          userDecision: makePendingDecision({ source: 'architect_plan' }),
        },
        {
          markdown: '# Initial Plan\n\n- Build with the free-form direction.\n\n## Verification Commands\n- npm test',
          verificationCommands: ['npm test'],
        },
      ];
      const freeform = '按 A 的方向做，但先不要碰 settings 页面，保留后续扩展点。';

      const created = await service.createTask({ title: 'Freeform decision task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId);

      const answered = await service.answerUserDirection(planned.state.taskId, freeform);

      expect(answered.state.status).toBe('ready_for_decision');
      expect(answered.state.requestedChanges.join('\n')).toContain(`User direction (raw, do not rewrite):\n${freeform}`);
      expect(answered.state.requestedChanges.join('\n')).toContain('Selected option: free-form answer / no exact A-D option selected');
      await expect(service.showArtifact(answered.state.taskId, 'decision-log')).resolves.toContain('selected option: free-form / no exact A-D match');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('pauses before review when the initial plan is only a plan-path status line', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [{
        markdown: 'Plan written to /fake/plan.md',
        verificationCommands: [],
      }];

      const created = await service.createTask({ title: 'Degenerate plan task', task: 'Build a feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'medium');

      expect(planned.state.status).toBe('waiting_user_direction');
      expect(planned.state.pendingUserPrompt).toContain('did not provide a usable plan artifact');
      expect(planned.state.pendingUserDecision?.source).toBe('plan_artifact_failure');
      expect(planned.state.pendingUserDecision?.options.map((option) => option.label)).toEqual(['Retry planning', 'Stop task']);
      expect(heavy.reviewerRuns).toBe(0);
      expect(planned.state.artifacts['revised-plan']).toBeUndefined();
      await expect(service.showArtifact(planned.state.taskId, 'plan-rounds-log')).resolves.toContain('Plan Artifact Failure');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('retries planning after a plan artifact failure user direction', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [
        {
          markdown: 'Plan written to /fake/plan.md',
          verificationCommands: [],
        },
        {
          markdown: '# Retried Plan\n\n- Build after retry.\n\n## Verification Commands\n- npm test',
          verificationCommands: ['npm test'],
        },
      ];

      const created = await service.createTask({ title: 'Retry degenerate plan task', task: 'Build a feature.' });
      const paused = await planThroughDifficulty(service, created.state.taskId, 'medium');
      const retried = await service.answerUserDirection(paused.state.taskId, '继续');

      expect(retried.state.status).toBe('ready_for_decision');
      expect(heavy.createInitialPlanRuns).toBe(2);
      expect(heavy.reviewerRuns).toBe(1);
      expect(retried.state.pendingUserDecision).toBeUndefined();
      await expect(service.showArtifact(retried.state.taskId, 'initial-plan')).resolves.toContain('# Retried Plan');
      expect(retried.state.requestedChanges.join('\n')).toContain('Retry planning after plan artifact failure');
      await expect(service.showArtifact(retried.state.taskId, 'decision-log')).resolves.toContain('decision source: plan_artifact_failure');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('pauses extra-high planning before a later review when revised plan output degenerates', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService();
    try {
      assistant.revisionInstructionsMarkdown = 'Address the reviewer feedback.';
      heavy.initialPlanResults = [{
        markdown: '# Extra Plan Round 1\n\n## Execution Unit 01: First pass',
        verificationCommands: ['npm test'],
      }];
      heavy.revisedPlanResults = [{
        markdown: 'Plan written to /fake/round-2.md',
        verificationCommands: [],
      }];
      heavy.reviewResults = [{
        markdown: 'Must fix: missing verification details.',
        reviewerBlockerOutput: reviewerIntroducesB1({ title: 'Missing verification details' }),
      }];

      const created = await service.createTask({ title: 'Extra high degenerate task', task: 'Build a careful feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'extra-high');

      expect(planned.state.status).toBe('waiting_user_direction');
      expect(heavy.reviewerRuns).toBe(1);
      expect(heavy.revisePlanRuns).toBe(1);
      const initialPlanArtifact = await service.showArtifact(planned.state.taskId, 'initial-plan');
      expect(initialPlanArtifact).toContain('# Extra Plan Round 1');
      expect(initialPlanArtifact).not.toContain('/fake/round-2.md');
      const log = await service.showArtifact(planned.state.taskId, 'plan-rounds-log');
      expect(log).toContain('## Round 1');
      expect(log).toContain('Plan Artifact Failure');
      expect(log).toContain('Plan written to /fake/round-2.md');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('records planner artifact source details in extra-high round logs', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [{
        markdown: '# Extra Plan Round 1\n\n## Execution Unit 01: First pass',
        verificationCommands: ['npm test'],
        sourcePath: 'C:\\temp\\claude-plan.md',
        stdoutSummary: 'Planner summary',
      }];
      heavy.reviewMarkdowns = ['No blocking issues.'];

      const created = await service.createTask({ title: 'Plan source log task', task: 'Build a careful feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'extra-high');

      expect(planned.state.status).toBe('ready_for_decision');
      const log = await service.showArtifact(planned.state.taskId, 'plan-rounds-log');
      expect(log).toContain('Planner Output Source: C:\\temp\\claude-plan.md');
      expect(log).toContain('Planner Stdout Summary: Planner summary');
      expect(log).toContain('### Planner Output');
      expect(log).toContain('# Extra Plan Round 1');
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
    ['extra-high', []],
    ['Extra High', []],
    ['Extra-High', []],
    ['extra high: do X', ['do X']],
    ['EXTRA_HIGH: keep the original prompt', ['keep the original prompt']],
  ])('canonicalizes %s to extra-high difficulty', async (reply, expectedChanges) => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.reviewMarkdowns = ['No blocking issues.'];
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

  it('high enforces reviewer blocker responses before ready_for_decision', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.reviewResults = [{
        markdown: 'Must fix: verification is missing.',
        reviewerBlockerOutput: reviewerIntroducesB1(),
      }];
      heavy.revisedPlanResults = [{
        markdown: '# High Revised Plan\n\n## Verification Commands\n- npm test',
        verificationCommands: ['npm test'],
        architectBlockerResponses: architectRespondsB1(),
      }];

      const created = await service.createTask({ title: 'High ledger task', task: 'Build a risky feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'high');

      expect(planned.state.status).toBe('ready_for_decision');
      expect(heavy.reviewerRuns).toBe(1);
      expect(heavy.revisePlanRuns).toBe(1);
      expect(heavy.revisePlanInputs[0]?.blockerLedgerText).toContain('B1 [blocker/test/open] Verification missing');
      const ledger = await service.showArtifact(planned.state.taskId, 'blocker-ledger');
      expect(ledger).toContain('Active blockers: 1');
      expect(ledger).toContain('architect_addressed');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('high pauses when Reviewer omits the required blocker ledger block', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.reviewResults = [{ markdown: 'Plain review without the required block.' }];

      const created = await service.createTask({ title: 'High missing reviewer ledger', task: 'Build a risky feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'high');

      expect(planned.state.status).toBe('waiting_user_direction');
      expect(planned.state.pendingUserPrompt).toContain('missing reviewer-blockers block');
      expect(heavy.revisePlanRuns).toBe(0);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('high pauses when Architect omits an active blocker response', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.reviewResults = [{
        markdown: 'Must fix: verification is missing.',
        reviewerBlockerOutput: reviewerIntroducesB1(),
      }];
      heavy.revisedPlanResults = [{
        markdown: '# High Revised Plan\n\nStill incomplete.',
        verificationCommands: ['npm test'],
      }];

      const created = await service.createTask({ title: 'High missing architect response', task: 'Build a risky feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'high');

      expect(planned.state.status).toBe('waiting_user_direction');
      expect(planned.state.pendingUserPrompt).toContain('missing architect-blocker-responses block');
      expect(planned.state.pendingUserPrompt).toContain('Architect blocker ledger output is invalid');
      const ledger = await service.showArtifact(planned.state.taskId, 'blocker-ledger');
      expect(ledger).toContain('B1: Verification missing');
      expect(ledger).not.toContain('architect_addressed');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('extra-high exits after round 1 approval and preserves plan metadata', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [{
        markdown: '# Extra Plan Round 1\n\n- Build carefully.\n\n## Verification Commands\n- npm test',
        verificationCommands: ['npm test'],
      }];
      heavy.reviewMarkdowns = ['No blocking issues.'];

      const created = await service.createTask({ title: 'Extra high approved task', task: 'Build a careful feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'extra-high');

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.difficulty).toBe('extra-high');
      expect(planned.state.reviewerRunCount).toBe(1);
      expect(heavy.createInitialPlanRuns).toBe(1);
      expect(heavy.reviewerRuns).toBe(1);
      expect(heavy.revisePlanRuns).toBe(0);
      expect(assistant.createRevisionInstructionsRuns).toBe(0);

      const log = await service.showArtifact(planned.state.taskId, 'plan-rounds-log');
      expect(log.match(/## Round /g)).toHaveLength(1);
      expect(log).toContain('verdict: approved');
      expect(log).toContain('next-round-directive: n/a - approved');

      const revisedPlan = await service.showArtifact(planned.state.taskId, 'revised-plan');
      expect(revisedPlan.replace(/\n\n<!-- assistant-plan-metadata[\s\S]*$/, '')).toBe(heavy.initialPlanResults[0].markdown);
      expect(revisedPlan).toContain('"verificationCommands"');
      expect(revisedPlan).toContain('"npm test"');
      await expect(service.showArtifact(planned.state.taskId, 'revision-instructions')).rejects.toThrow();
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('extra-high revises once and exits when round 2 is approved', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [{
        markdown: '# Extra Plan Round 1\n\n- Initial approach.',
        verificationCommands: ['npm test'],
      }];
      heavy.revisedPlanResults = [{
        markdown: '# Extra Plan Round 2\n\n- Clarified artifact boundaries.',
        verificationCommands: ['npm test', 'npm run build'],
      }];
      heavy.revisedPlanResults[0] = {
        ...heavy.revisedPlanResults[0],
        architectBlockerResponses: architectRespondsB1({ planAnchor: '## Execution Unit 01: Artifact boundaries' }),
      };
      heavy.reviewResults = [
        {
          markdown: 'Must fix: artifact boundaries are unclear.',
          reviewerBlockerOutput: reviewerIntroducesB1({
            category: 'design',
            title: 'Artifact boundaries unclear',
            detail: 'The plan does not define which artifacts change.',
            verifyHint: 'Architect should anchor the artifact boundaries in the revised plan.',
          }),
        },
        {
          markdown: 'Approved.',
          reviewerBlockerOutput: reviewerVerdictsB1('closed', 'Artifact boundaries are now explicit.'),
        },
      ];

      const created = await service.createTask({ title: 'Extra high round two task', task: 'Build a careful feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'extra-high');

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.reviewerRunCount).toBe(2);
      expect(heavy.createInitialPlanRuns).toBe(1);
      expect(heavy.reviewerRuns).toBe(2);
      expect(heavy.revisePlanRuns).toBe(1);
      expect(assistant.createRevisionInstructionsRuns).toBe(0);

      const log = await service.showArtifact(planned.state.taskId, 'plan-rounds-log');
      expect(log.match(/## Round /g)).toHaveLength(2);
      expect(log).toContain('verdict: revision_requested');
      expect(log).toContain('next-round-directive: Close every active Reviewer blocker ID in the next revised plan.');
      expect(log).toContain('verdict: approved');

      const revisedPlan = await service.showArtifact(planned.state.taskId, 'revised-plan');
      expect(revisedPlan.replace(/\n\n<!-- assistant-plan-metadata[\s\S]*$/, '')).toBe(heavy.revisedPlanResults[0].markdown);
      expect(revisedPlan).toContain('"npm run build"');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('extra-high pauses at the 3-round cap and asks before continuing', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [{
        markdown: '# Extra Plan Round 1\n\n- Initial approach.',
        verificationCommands: ['npm test'],
      }];
      heavy.revisedPlanResults = [
        {
          markdown: '# Extra Plan Round 2\n\n- First revision.',
          verificationCommands: ['npm test'],
        },
        {
          markdown: '# Extra Plan Round 3\n\n- Latest capped plan.',
          verificationCommands: ['npm test', 'npm run build'],
        },
      ];
      heavy.revisedPlanResults[0] = {
        ...heavy.revisedPlanResults[0],
        architectBlockerResponses: architectRespondsB1({ status: 'partially_addressed', summary: 'Added a partial migration note.', planAnchor: '## Migration' }),
      };
      heavy.revisedPlanResults[1] = {
        ...heavy.revisedPlanResults[1],
        architectBlockerResponses: architectRespondsB1({ status: 'partially_addressed', summary: 'Added partial verification but final handoff remains thin.', planAnchor: '## Verification Commands' }),
      };
      heavy.reviewResults = [
        {
          markdown: 'Must fix: missing migration path.',
          reviewerBlockerOutput: reviewerIntroducesB1({
            category: 'risk',
            title: 'Missing migration path',
            detail: 'The plan does not explain migration from the current runtime.',
            verifyHint: 'Architect should add a migration section.',
          }),
        },
        {
          markdown: 'Blocking issue: verification is underspecified.',
          reviewerBlockerOutput: reviewerVerdictsB1('still_open', 'Verification is still underspecified.'),
        },
        {
          markdown: 'Approved with blockers: final review handoff remains unclear.',
          reviewerBlockerOutput: reviewerVerdictsB1('still_open', 'Final review handoff remains unclear.'),
        },
      ];

      const created = await service.createTask({ title: 'Extra high capped task', task: 'Build a careful feature.' });
      const planned = await planThroughDifficulty(service, created.state.taskId, 'extra-high');

      expect(planned.state.status).toBe('waiting_user_direction');
      expect(planned.state.reviewerRunCount).toBe(3);
      expect(planned.state.pendingUserDecision?.source).toBe('extra_high_planning');
      expect(planned.state.pendingUserDecision?.options.map((option) => option.label)).toEqual([
        'Continue one round',
        'Restart planning',
        'Execute current plan',
      ]);
      expect(heavy.createInitialPlanRuns).toBe(1);
      expect(heavy.reviewerRuns).toBe(3);
      expect(heavy.revisePlanRuns).toBe(2);
      expect(assistant.createRevisionInstructionsRuns).toBe(0);

      const log = await service.showArtifact(planned.state.taskId, 'plan-rounds-log');
      expect(log.match(/## Round /g)).toHaveLength(3);
      expect(log).toContain('verdict: issues_remain');
      expect(log).toContain('## Outstanding Blocker Ledger');
      expect(log).toContain('B1 (blocker, risk): Missing migration path');

      const decisionLog = await service.showArtifact(planned.state.taskId, 'decision-log');
      expect(decisionLog).toContain('extra-high planning paused after round 3');

      const revisedPlan = await service.showArtifact(planned.state.taskId, 'revised-plan');
      expect(revisedPlan).toMatch(/^> Note: Extra High planning paused after round 3 with 1 active blocker/);
      expect(revisedPlan).toContain('# Extra Plan Round 3');

      const approveAttempt = await service.reply(planned.state.taskId, 'approve A');
      expect(approveAttempt.state.status).toBe('waiting_user_direction');
      expect(heavy.implementRuns).toBe(0);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('extra-high option C executes the current plan despite remaining blockers', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService();
    try {
      assistant.revisionInstructionsMarkdown = 'Address the latest reviewer blocker.';
      heavy.initialPlanResults = [{
        markdown: '# Extra Plan Round 1\n\n- Initial approach.',
        verificationCommands: ['npm test'],
      }];
      heavy.revisedPlanResults = [
        { markdown: '# Extra Plan Round 2\n\n- First revision.', verificationCommands: ['npm test'] },
        { markdown: '# Extra Plan Round 3\n\n- Latest blocked plan.', verificationCommands: ['npm test'] },
      ];
      heavy.revisedPlanResults[0] = {
        ...heavy.revisedPlanResults[0],
        architectBlockerResponses: architectRespondsB1({ status: 'partially_addressed', summary: 'Added partial migration notes.', planAnchor: '## Migration' }),
      };
      heavy.revisedPlanResults[1] = {
        ...heavy.revisedPlanResults[1],
        architectBlockerResponses: architectRespondsB1({ status: 'partially_addressed', summary: 'Added partial final review notes.', planAnchor: '## Final Review' }),
      };
      heavy.reviewResults = [
        {
          markdown: 'Must fix: missing migration path.',
          reviewerBlockerOutput: reviewerIntroducesB1({ category: 'risk', title: 'Missing migration path' }),
        },
        {
          markdown: 'Blocking issue: verification is underspecified.',
          reviewerBlockerOutput: reviewerVerdictsB1('still_open', 'Verification is still underspecified.'),
        },
        {
          markdown: 'Blocking issue: final review handoff remains unclear.',
          reviewerBlockerOutput: reviewerVerdictsB1('still_open', 'Final review handoff remains unclear.'),
        },
      ];

      const created = await service.createTask({ title: 'Extra high override task', task: 'Build a careful feature.' });
      const paused = await planThroughDifficulty(service, created.state.taskId, 'extra-high');
      expect(paused.state.status).toBe('waiting_user_direction');

      const implemented = await service.answerUserDirection(paused.state.taskId, 'C');

      expect(implemented.state.status).toBe('awaiting_user_acceptance');
      expect(implemented.state.pendingUserDecision).toBeUndefined();
      expect(implemented.state.pendingUserPrompt).toContain('等你验收');
      expect(heavy.implementRuns).toBeGreaterThan(0);
      expect(heavy.finalReviewRuns).toBe(1);
      const decisionLog = await service.showArtifact(implemented.state.taskId, 'decision-log');
      expect(decisionLog).toContain('selected option: C. Execute current plan');
      expect(decisionLog).toContain('extra-high override: execute current plan despite outstanding reviewer blockers');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('extra-high continues exactly one reviewer round when the user chooses continue', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService();
    try {
      assistant.revisionInstructionsMarkdown = 'Address the latest reviewer blocker.';
      heavy.initialPlanResults = [{
        markdown: '# Extra Plan Round 1\n\n- Initial approach.',
        verificationCommands: ['npm test'],
      }];
      heavy.revisedPlanResults = [
        { markdown: '# Extra Plan Round 2\n\n- First revision.', verificationCommands: ['npm test'] },
        { markdown: '# Extra Plan Round 3\n\n- Latest capped plan.', verificationCommands: ['npm test'] },
        { markdown: '# Extra Plan Round 4\n\n- Continued and fixed.', verificationCommands: ['npm test', 'npm run build'] },
      ];
      heavy.revisedPlanResults[0] = {
        ...heavy.revisedPlanResults[0],
        architectBlockerResponses: architectRespondsB1({ status: 'partially_addressed', summary: 'Added partial migration notes.', planAnchor: '## Migration' }),
      };
      heavy.revisedPlanResults[1] = {
        ...heavy.revisedPlanResults[1],
        architectBlockerResponses: architectRespondsB1({ status: 'partially_addressed', summary: 'Added partial final review notes.', planAnchor: '## Final Review' }),
      };
      heavy.revisedPlanResults[2] = {
        ...heavy.revisedPlanResults[2],
        architectBlockerResponses: architectRespondsB1({ summary: 'Completed the blocker response.', planAnchor: '## Verification Commands' }),
      };
      heavy.reviewResults = [
        {
          markdown: 'Must fix: missing migration path.',
          reviewerBlockerOutput: reviewerIntroducesB1({ category: 'risk', title: 'Missing migration path' }),
        },
        {
          markdown: 'Blocking issue: verification is underspecified.',
          reviewerBlockerOutput: reviewerVerdictsB1('still_open', 'Verification is still underspecified.'),
        },
        {
          markdown: 'Blocking issue: final review handoff remains unclear.',
          reviewerBlockerOutput: reviewerVerdictsB1('still_open', 'Final review handoff remains unclear.'),
        },
        {
          markdown: 'No blocking issues.',
          reviewerBlockerOutput: reviewerVerdictsB1('closed', 'The continued plan closes the remaining blocker.'),
        },
      ];

      const created = await service.createTask({ title: 'Extra high continue task', task: 'Build a careful feature.' });
      const paused = await planThroughDifficulty(service, created.state.taskId, 'extra-high');
      expect(paused.state.status).toBe('waiting_user_direction');

      const continued = await service.answerUserDirection(paused.state.taskId, 'A');

      expect(continued.state.status).toBe('ready_for_decision');
      expect(continued.state.reviewerRunCount).toBe(4);
      expect(heavy.createInitialPlanRuns).toBe(1);
      expect(heavy.reviewerRuns).toBe(4);
      expect(heavy.revisePlanRuns).toBe(3);
      expect(assistant.createRevisionInstructionsRuns).toBe(0);

      const log = await service.showArtifact(continued.state.taskId, 'plan-rounds-log');
      expect(log.match(/## Round /g)).toHaveLength(4);
      expect(log).toContain('## Round 4');
      expect(log).toContain('verdict: approved');

      const revisedPlan = await service.showArtifact(continued.state.taskId, 'revised-plan');
      expect(revisedPlan.replace(/\n\n<!-- assistant-plan-metadata[\s\S]*$/, '')).toBe(heavy.revisedPlanResults[2].markdown);
      expect(revisedPlan).toContain('"npm run build"');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('extra-high asks again after each user-approved continuation if blockers remain', async () => {
    const { root, targetDir, service, assistant, heavy } = await makeService();
    try {
      assistant.revisionInstructionsMarkdown = 'Address the latest reviewer blocker.';
      heavy.initialPlanResults = [{
        markdown: '# Extra Plan Round 1\n\n- Initial approach.',
        verificationCommands: ['npm test'],
      }];
      heavy.revisedPlanResults = [
        { markdown: '# Extra Plan Round 2\n\n- First revision.', verificationCommands: ['npm test'] },
        { markdown: '# Extra Plan Round 3\n\n- Latest capped plan.', verificationCommands: ['npm test'] },
        { markdown: '# Extra Plan Round 4\n\n- Still not enough.', verificationCommands: ['npm test'] },
      ];
      heavy.revisedPlanResults[0] = {
        ...heavy.revisedPlanResults[0],
        architectBlockerResponses: architectRespondsB1({ status: 'partially_addressed', summary: 'Added partial migration notes.', planAnchor: '## Migration' }),
      };
      heavy.revisedPlanResults[1] = {
        ...heavy.revisedPlanResults[1],
        architectBlockerResponses: architectRespondsB1({ status: 'partially_addressed', summary: 'Added partial final review notes.', planAnchor: '## Final Review' }),
      };
      heavy.revisedPlanResults[2] = {
        ...heavy.revisedPlanResults[2],
        architectBlockerResponses: architectRespondsB1({ status: 'partially_addressed', summary: 'Continuation still leaves cleanup thin.', planAnchor: '## Cleanup' }),
      };
      heavy.reviewResults = [
        {
          markdown: 'Must fix: missing migration path.',
          reviewerBlockerOutput: reviewerIntroducesB1({ category: 'risk', title: 'Missing migration path' }),
        },
        {
          markdown: 'Blocking issue: verification is underspecified.',
          reviewerBlockerOutput: reviewerVerdictsB1('still_open', 'Verification is still underspecified.'),
        },
        {
          markdown: 'Blocking issue: final review handoff remains unclear.',
          reviewerBlockerOutput: reviewerVerdictsB1('still_open', 'Final review handoff remains unclear.'),
        },
        {
          markdown: 'Must fix: continuation still misses the cleanup contract.',
          reviewerBlockerOutput: reviewerVerdictsB1('still_open', 'Continuation still misses the cleanup contract.'),
        },
      ];

      const created = await service.createTask({ title: 'Extra high repeated pause task', task: 'Build a careful feature.' });
      const paused = await planThroughDifficulty(service, created.state.taskId, 'extra-high');
      const continued = await service.answerUserDirection(paused.state.taskId, 'A');

      expect(continued.state.status).toBe('waiting_user_direction');
      expect(continued.state.reviewerRunCount).toBe(4);
      expect(continued.state.pendingUserDecision?.id).toBe('extra-high-planning:round-4');
      expect(heavy.reviewerRuns).toBe(4);
      expect(heavy.revisePlanRuns).toBe(3);
      expect(assistant.createRevisionInstructionsRuns).toBe(0);

      const log = await service.showArtifact(continued.state.taskId, 'plan-rounds-log');
      expect(log.match(/## Round /g)).toHaveLength(4);
      expect(log).toContain('verdict: issues_remain');

      const decisionLog = await service.showArtifact(continued.state.taskId, 'decision-log');
      expect(decisionLog).toContain('extra-high planning paused after round 4');
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

describe('isReviewerApproval', () => {
  it.each([
    ['No blocking issues.', true],
    ['LGTM', true],
    ['Approved.', true],
    ['Looks good, but must fix X', false],
    ['Approved with blockers', false],
    ['没有阻塞问题', true],
    ['', false],
    ['   ', false],
  ])('classifies %s as %s', (markdown, expected) => {
    expect(isReviewerApproval(markdown)).toBe(expected);
  });
});
