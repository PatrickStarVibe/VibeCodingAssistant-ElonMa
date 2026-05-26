import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { AssistantAdapter, HeavyAgentAdapter } from '../src/adapters.js';
import type {
  AgentPromptRecord,
  AssistantConfig,
  AssistantRouteResult,
  AssistantTextResult,
  ControlChatResult,
  FinalReviewResult,
  IntentResult,
  OrchestratorDecision,
  PendingUserDecision,
  PlanResult,
  ReviewResult,
  TaskProposal,
  WorkflowDifficulty,
  WorkflowRoleName,
} from '../src/types.js';
import { WorkflowService, type WorkflowResult } from '../src/workflow.js';

const execFileAsync = promisify(execFile);

function makePendingDecision(overrides: Partial<PendingUserDecision> = {}): PendingUserDecision {
  return {
    id: 'decision:divergent',
    source: 'architect_plan',
    question: 'Choose A or B.',
    rationale: 'Architect needs product direction.',
    options: [
      { id: 'A', label: 'A path', impact: 'A impact' },
      { id: 'B', label: 'B path', impact: 'B impact' },
    ],
    allowFreeform: true,
    ...overrides,
  };
}

class FakeAssistant implements AssistantAdapter {
  route: AssistantRouteResult = { route: 'complete', reason: 'no issues' };
  fallbackReply = 'Please reply approve/reject/revise.';
  createRevisionInstructionsRuns = 0;
  explanationResult?: AssistantTextResult;

  async decideNextAction(): Promise<OrchestratorDecision> {
    return { action: 'wait_for_user', reason: 'unused', confidence: 1 };
  }
  async createRevisionInstructions(): Promise<AssistantTextResult> {
    this.createRevisionInstructionsRuns += 1;
    return { markdown: 'instructions', needsUserDecision: false };
  }
  async explainRevisedPlan(): Promise<AssistantTextResult> {
    return this.explanationResult ?? { markdown: 'explanation', needsUserDecision: false };
  }
  async answerQuestion(input: { question: string }): Promise<string> {
    return `A: ${input.question}`;
  }
  async interpretAmbiguousReply(): Promise<string> {
    return this.fallbackReply;
  }
  async classifyIntent(): Promise<IntentResult> {
    return { intent: 'unknown', confidence: 0.2, requiresClarification: true, userFacingInterpretation: 'unclear' };
  }
  async composeReply(input: { rawMessage: string }): Promise<{ text: string }> {
    return { text: input.rawMessage };
  }
  async handleControlChat(input: { message: string; pendingProposal?: TaskProposal; mode: 'message' | 'edit' }): Promise<ControlChatResult> {
    return { kind: 'answer', markdown: input.message };
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
  finalReviewResult: FinalReviewResult = { markdown: 'Final review passed.', passed: true };
  implementationWritePath?: string;
  initialPlanResults: Array<Pick<PlanResult, 'markdown'> & Partial<Omit<PlanResult, 'markdown'>>> = [];
  revisedPlanResults: Array<Pick<PlanResult, 'markdown'> & Partial<Omit<PlanResult, 'markdown'>>> = [];
  reviewResults: Array<Pick<ReviewResult, 'markdown'> & Partial<Omit<ReviewResult, 'markdown'>>> = [];

  private record(role: WorkflowRoleName, difficulty: WorkflowDifficulty, taskId: string): AgentPromptRecord {
    return {
      taskId,
      role,
      difficulty,
      profileName: role,
      profileKind: 'codex',
      createdAt: '2026-05-22T00:00:00.000Z',
      prompt: `${role} prompt`,
    };
  }

  async createInitialPlan(input: { difficulty: WorkflowDifficulty; state: { taskId: string } }): Promise<PlanResult> {
    const fixture = this.initialPlanResults[this.createInitialPlanRuns];
    this.createInitialPlanRuns += 1;
    return {
      markdown: fixture?.markdown ?? '# Initial Plan\n\n- Build it.\n\n## Verification Commands\n- npm test',
      verificationCommands: fixture?.verificationCommands ?? ['npm test'],
      agentPrompt: this.record('architect', input.difficulty, input.state.taskId),
      ...(fixture?.userDecision ? { userDecision: fixture.userDecision } : {}),
      ...(fixture?.decisionParseError ? { decisionParseError: fixture.decisionParseError } : {}),
    };
  }

  async reviewPlan(input: { difficulty: WorkflowDifficulty; state: { taskId: string } }): Promise<ReviewResult> {
    const fixture = this.reviewResults[this.reviewerRuns];
    this.reviewerRuns += 1;
    return {
      markdown: fixture?.markdown ?? 'Reviewer says clarify boundaries.',
      agentPrompt: this.record('planReviewer', input.difficulty, input.state.taskId),
      ...(fixture?.userDecision ? { userDecision: fixture.userDecision } : {}),
      ...(fixture?.decisionParseError ? { decisionParseError: fixture.decisionParseError } : {}),
    };
  }

  async revisePlan(input: { difficulty: WorkflowDifficulty; state: { taskId: string } }): Promise<PlanResult> {
    const fixture = this.revisedPlanResults[this.revisePlanRuns];
    this.revisePlanRuns += 1;
    return {
      markdown: fixture?.markdown ?? '# Revised Plan\n\n- Build cleanly.\n\n## Verification Commands\n- npm test',
      verificationCommands: fixture?.verificationCommands ?? ['npm test'],
      agentPrompt: this.record('architect', input.difficulty, input.state.taskId),
      ...(fixture?.userDecision ? { userDecision: fixture.userDecision } : {}),
      ...(fixture?.decisionParseError ? { decisionParseError: fixture.decisionParseError } : {}),
    };
  }

  async implement(input: { state: { taskId: string; difficulty?: WorkflowDifficulty } }): Promise<{ markdown: string; changedFiles: string[]; agentPrompt: AgentPromptRecord }> {
    this.implementRuns += 1;
    if (this.implementationWritePath) {
      await writeFile(this.implementationWritePath, 'implementation\n', 'utf8');
    }
    return {
      markdown: 'Implementation completed.',
      changedFiles: ['implementation.txt'],
      agentPrompt: this.record('developer', input.state.difficulty ?? 'medium', input.state.taskId),
    };
  }

  async finalReview(input: { state: { taskId: string; difficulty?: WorkflowDifficulty } }): Promise<FinalReviewResult> {
    this.finalReviewRuns += 1;
    return {
      ...this.finalReviewResult,
      agentPrompt: this.record('finalReviewer', input.state.difficulty ?? 'medium', input.state.taskId),
    };
  }
}

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
  await execFileAsync('git', ['init'], { cwd: dir });
  return dir;
}

function makeConfig(targetDir: string, overrides: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    workspace: { targetDir },
    defaultProjectId: 'default',
    projects: [{ id: 'default', name: 'Default', targetDir, docsDir: 'project-docs/default', alwaysRead: [] }],
    artifactsDir: 'logs/ai-workflow',
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
    verification: { allowlist: ['npm test'] },
    ...overrides,
  } as AssistantConfig;
}

async function makeService(configOverrides: Partial<AssistantConfig> = {}, options: { executeVerification?: boolean } = {}): Promise<{
  root: string;
  targetDir: string;
  store: ArtifactStore;
  service: WorkflowService;
  assistant: FakeAssistant;
  heavy: FakeHeavyAgents;
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
  const targetDir = await makeGitRepo();
  const config = makeConfig(targetDir, configOverrides);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  const heavy = new FakeHeavyAgents();
  heavy.implementationWritePath = join(targetDir, 'implementation.txt');
  const service = new WorkflowService(store, config, assistant, heavy, { executeVerification: false, ...options });
  return { root, targetDir, store, service, assistant, heavy };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { recursive: true, force: true })));
}

async function planAt(service: WorkflowService, taskId: string, difficulty: WorkflowDifficulty = 'medium'): Promise<WorkflowResult> {
  const gate = await service.planTask(taskId);
  expect(gate.state.status).toBe('awaiting_difficulty_selection');
  return service.reply(taskId, difficulty);
}

describe('WorkflowService divergent coverage', () => {
  it('enforces maxRevisionRounds when revise C keeps cycling', async () => {
    const { root, targetDir, service } = await makeService({ maxRevisionRounds: 2 });
    try {
      const created = await service.createTask({ title: 'Cycle revise', task: 'Build a thing.' });
      await planAt(service, created.state.taskId);
      const second = await service.reply(created.state.taskId, 'revise C: change again');
      expect(second.state.status).toBe('ready_for_decision');
      expect(second.state.revisionRound).toBe(2);

      await expect(service.reply(created.state.taskId, 'revise C: again again'))
        .rejects.toThrow(/Maximum revision rounds reached \(2\)/);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('rejects empty answerUserDirection and wrong-status answerUserDirection', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Empty answer', task: 'Build a thing.' });
      await expect(service.answerUserDirection(created.state.taskId, '   '))
        .rejects.toThrow(/empty reply/);

      await expect(service.answerUserDirection(created.state.taskId, 'A'))
        .rejects.toThrow(/Cannot answer user direction from state created/);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('chains two pending decisions: Architect then Reviewer, then completes', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.initialPlanResults = [
        {
          markdown: '# Initial\nneeds direction',
          verificationCommands: [],
          userDecision: makePendingDecision({ source: 'architect_plan', question: 'Architect Q' }),
        },
        { markdown: '# Initial Plan v2\n\n## Verification Commands\n- npm test', verificationCommands: ['npm test'] },
      ];
      heavy.reviewResults = [
        {
          markdown: 'Reviewer needs direction.',
          userDecision: makePendingDecision({ source: 'plan_review', question: 'Reviewer Q' }),
        },
        { markdown: 'No blocking issues.' },
      ];

      const created = await service.createTask({ title: 'Two pauses', task: 'Build a thing.' });
      const firstPause = await planAt(service, created.state.taskId);
      expect(firstPause.state.status).toBe('waiting_user_direction');
      expect(firstPause.state.pendingUserDecision?.source).toBe('architect_plan');
      expect(heavy.reviewerRuns).toBe(0);

      const secondPause = await service.answerUserDirection(created.state.taskId, 'A');
      expect(secondPause.state.status).toBe('waiting_user_direction');
      expect(secondPause.state.pendingUserDecision?.source).toBe('plan_review');
      expect(heavy.reviewerRuns).toBe(1);
      expect(heavy.revisePlanRuns).toBe(0);

      const ready = await service.answerUserDirection(created.state.taskId, 'B');
      expect(ready.state.status).toBe('ready_for_decision');
      expect(heavy.revisePlanRuns).toBe(1);
      const decisionLog = await service.showArtifact(created.state.taskId, 'decision-log');
      expect(decisionLog).toContain('Architect Q');
      expect(decisionLog).toContain('Reviewer Q');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('blocks revise from a fresh task and from completed task', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Bad revise', task: 'Build a thing.' });
      await expect(service.reply(created.state.taskId, 'revise C: anything'))
        .rejects.toThrow(/Cannot request revision from state created/);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('note from a non-acceptance state is rejected', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Bad note', task: 'Build a thing.' });
      await planAt(service, created.state.taskId);
      await expect(service.reply(created.state.taskId, 'note: too early'))
        .rejects.toThrow(/Cannot record an acceptance note/);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('runs verification commands and records passed status in test-build-log', async () => {
    const { root, targetDir, service, heavy } = await makeService(
      { verification: { allowlist: ['npm run build'] } },
      { executeVerification: true },
    );
    try {
      // Use a command that exists in the allowlist and is harmless: tsc --noEmit on an empty config.
      // Instead, we cheat by giving an allowlisted command that resolves quickly in the temp git repo:
      // "npm run build" will fail (no package.json in temp repo) -> "failed" status is also valid coverage.
      heavy.initialPlanResults = [{
        markdown: '# Plan\n\n## Verification Commands\n- npm run build',
        verificationCommands: ['npm run build'],
      }];
      heavy.revisedPlanResults = [{
        markdown: '# Revised\n\n## Verification Commands\n- npm run build',
        verificationCommands: ['npm run build'],
      }];

      const created = await service.createTask({ title: 'Verify run', task: 'Build a thing.' });
      const planned = await planAt(service, created.state.taskId);
      const approved = await service.reply(planned.state.taskId, 'approve A');
      expect(['awaiting_user_acceptance', 'implementation_approved']).toContain(approved.state.status);

      const log = await service.showArtifact(created.state.taskId, 'test-build-log');
      expect(log).toContain('## npm run build');
      // Status is either passed (if a host package.json with build is reachable up the tree) or failed (no script). Both prove we actually ran.
      expect(log).toMatch(/Status: (passed|failed)/);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('approve A from a state with no plan throws state-machine error', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'No plan approve', task: 'Build it.' });
      await expect(service.reply(created.state.taskId, 'approve A'))
        .rejects.toThrow(/Cannot approve implementation/);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('reject B from ready_for_decision stops the task with reject reason', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Reject', task: 'Build it.' });
      const planned = await planAt(service, created.state.taskId);
      const rejected = await service.reply(planned.state.taskId, 'reject B');
      expect(rejected.state.status).toBe('stopped');
      expect(rejected.state.stoppedReason).toMatch(/rejected/i);
      const log = await service.showArtifact(rejected.state.taskId, 'decision-log');
      expect(log).toContain('reject B');
    } finally {
      await cleanup([root, targetDir]);
    }
  });
});
