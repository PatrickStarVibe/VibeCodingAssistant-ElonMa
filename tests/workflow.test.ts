import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, ManagerAdapter } from '../src/adapters.js';
import type {
  ControlChatResult,
  FinalReviewResult,
  IntentResult,
  ManagerConfig,
  ManagerRouteResult,
  ManagerTextResult,
  PlanResult,
  TaskChatRouteResult,
  TaskProposal,
  WorkflowDifficulty,
} from '../src/types.js';
import { createHeavyAgentAdapter } from '../src/adapters.js';
import { WorkflowService, type WorkflowResult } from '../src/workflow.js';

const execFileAsync = promisify(execFile);
const gb18030Decoder = new TextDecoder('gb18030');
const utf8Encoder = new TextEncoder();

function simulateUtf8ReadAsGbk(value: string): string {
  return gb18030Decoder.decode(utf8Encoder.encode(value));
}

class FakeManager implements ManagerAdapter {
  route: ManagerRouteResult = { route: 'complete', reason: 'No blocking issues.' };
  fallbackReply = '我理解你想继续，但请明确回复 approve A、reject B 或 revise C: ... 之一。';
  briefCalls: { task: string; revisions: string[] }[] = [];
  briefProjectContexts: string[] = [];

  async createTaskBrief(input: { task: string; projectContext: string; briefRevisionRequests: string[] }): Promise<ManagerTextResult> {
    this.briefCalls.push({ task: input.task, revisions: [...input.briefRevisionRequests] });
    this.briefProjectContexts.push(input.projectContext);
    const corrections = input.briefRevisionRequests.length > 0
      ? `\n\nCorrections applied:\n${input.briefRevisionRequests.join('\n')}`
      : '';
    return { markdown: `## 需求摘要\nBrief for:\n${input.task}${corrections}`, needsUserDecision: false };
  }

  async createRevisionInstructions(): Promise<ManagerTextResult> {
    return { markdown: 'Revise the plan using reviewer feedback and user-requested changes.', needsUserDecision: false };
  }

  async explainRevisedPlan(): Promise<ManagerTextResult> {
    return { markdown: 'Manager explanation of the revised plan.', needsUserDecision: false };
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

  async routeTaskChat(input: { message: string }): Promise<TaskChatRouteResult> {
    return {
      action: 'reply_only',
      confidence: 0.9,
      reason: `test fallback for ${input.message}`,
      replyMarkdown: this.fallbackReply,
    };
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

  async routeAfterFinalReview(): Promise<ManagerRouteResult> {
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

  async createInitialPlan(input: { difficulty: WorkflowDifficulty; projectContext: string }): Promise<PlanResult> {
    this.difficultyCalls.push(input.difficulty);
    this.initialPlanProjectContexts.push(input.projectContext);
    return {
      markdown: '# Initial Plan\n\n- Build the workflow.\n\n## Verification Commands\n- npm test',
      verificationCommands: ['npm test'],
      ...(this.planPackDraft ? { planPackDraft: this.planPackDraft } : {}),
    };
  }

  async reviewPlan(input: { difficulty: WorkflowDifficulty }): Promise<{ markdown: string }> {
    this.reviewerRuns += 1;
    this.difficultyCalls.push(input.difficulty);
    return { markdown: 'Reviewer says the plan should clarify artifact boundaries.' };
  }

  async revisePlan(input: { difficulty: WorkflowDifficulty }): Promise<PlanResult> {
    this.difficultyCalls.push(input.difficulty);
    return {
      markdown: '# Revised Plan\n\n- Build the workflow with explicit artifact boundaries.\n\n## Verification Commands\n- npm test\n- node unsafe.js',
      verificationCommands: ['npm test', 'node unsafe.js'],
      ...(this.planPackDraft ? { planPackDraft: this.planPackDraft } : {}),
    };
  }

  async implement(input: { projectContext: string }): Promise<{ markdown: string; changedFiles: string[] }> {
    this.implementRuns += 1;
    this.implementationProjectContexts.push(input.projectContext);
    if (this.implementationWritePath) {
      await writeFile(this.implementationWritePath, 'implementation output\n', 'utf8');
    }
    return { markdown: this.implementationMarkdown, changedFiles: ['implementation.txt'] };
  }

  async finalReview(): Promise<FinalReviewResult> {
    this.finalReviewRuns += 1;
    return this.finalReviewResult;
  }
}

async function makeGitRepo(): Promise<string> {
  const targetDir = await mkdtemp(join(tmpdir(), 'manager-target-'));
  await execFileAsync('git', ['init'], { cwd: targetDir });
  return targetDir;
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
    verification: {
      allowlist: ['npm test'],
    },
  };
}

function makeProjectConfig(targetDir: string): ManagerConfig {
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

async function makeService(route?: ManagerRouteResult): Promise<{
  root: string;
  targetDir: string;
  service: WorkflowService;
  manager: FakeManager;
  heavy: FakeHeavyAgents;
}> {
  const root = await mkdtemp(join(tmpdir(), 'manager-root-'));
  const targetDir = await makeGitRepo();
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const manager = new FakeManager();
  if (route) manager.route = route;
  const heavy = new FakeHeavyAgents();
  heavy.implementationWritePath = join(targetDir, 'implementation.txt');
  const service = new WorkflowService(store, config, manager, heavy, { executeVerification: false });
  return { root, targetDir, service, manager, heavy };
}

async function makeProjectService(): Promise<{
  root: string;
  targetDir: string;
  service: WorkflowService;
  manager: FakeManager;
  heavy: FakeHeavyAgents;
}> {
  const root = await mkdtemp(join(tmpdir(), 'manager-root-'));
  const targetDir = await makeGitRepo();
  const docsDir = join(root, 'project-docs', 'ireader');
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, 'rules.md'), '# Rules\nUse the contextual translation architecture.\n', 'utf8');
  await writeFile(join(docsDir, 'translation.md'), '# Translation Planner\nPlanner owns route summaries.\n', 'utf8');
  const config = makeProjectConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const manager = new FakeManager();
  const heavy = new FakeHeavyAgents();
  heavy.implementationWritePath = join(targetDir, 'implementation.txt');
  const service = new WorkflowService(store, config, manager, heavy, { executeVerification: false });
  return { root, targetDir, service, manager, heavy };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

async function planThroughBrief(service: WorkflowService, taskId: string): Promise<WorkflowResult> {
  const briefStop = await service.planTask(taskId);
  expect(briefStop.state.status).toBe('awaiting_brief_confirmation');
  const difficultyStop = await service.reply(taskId, 'approve A');
  expect(difficultyStop.state.status).toBe('awaiting_difficulty_selection');
  expect(difficultyStop.state.pendingUserPrompt).toContain('low');
  expect(difficultyStop.state.pendingUserPrompt).toContain('medium');
  expect(difficultyStop.state.pendingUserPrompt).toContain('high');
  return service.reply(taskId, 'medium');
}

describe('WorkflowService', () => {
  it('runs create and plan through explanation while reviewing only once', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'Reader task', task: 'Build a feature.' });
      expect(created.state.projectId).toBe('default');
      const planned = await planThroughBrief(service, created.state.taskId);

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.briefConfirmed).toBe(true);
      expect(planned.state.reviewerRunCount).toBe(1);
      expect(heavy.reviewerRuns).toBe(1);
      expect(await service.showArtifact(planned.state.taskId, 'revised-plan')).toContain('manager-plan-metadata');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('binds tasks to projects and injects project Markdown into manager and heavy-agent prompts', async () => {
    const { root, targetDir, service, manager, heavy } = await makeProjectService();
    try {
      const created = await service.createTask({
        title: 'Project memory task',
        task: 'Improve the translation planner.',
        projectId: 'ireader',
      });
      expect(created.state.projectId).toBe('ireader');

      const planned = await planThroughBrief(service, created.state.taskId);
      await service.reply(planned.state.taskId, 'approve A');

      expect(manager.briefProjectContexts[0]).toContain('rules.md#Rules');
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
      const planned = await planThroughBrief(service, created.state.taskId);
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
        `\u001b[36m${simulateUtf8ReadAsGbk('中文文件读取')}\u001b[39m`,
      ].join('\n');
      await writeFile(join(targetDir, 'preexisting.txt'), 'dirty before implementation\n', 'utf8');
      const created = await service.createTask({ title: 'Approve task', task: 'Build a feature.' });
      const planned = await planThroughBrief(service, created.state.taskId);
      const approved = await service.reply(planned.state.taskId, 'A');

      expect(approved.state.status).toBe('awaiting_user_acceptance');
      const accepted = await service.reply(planned.state.taskId, 'accept');
      expect(accepted.state.status).toBe('completed');
      const report = await service.showArtifact(accepted.state.taskId, 'final-report');
      expect(report).toContain('## 本次 implementation 产生的 diff');
      expect(report).toContain('中文文件读取');
      expect(report).not.toContain('\u001b[');
      expect(report).toContain('implementation.txt');
      expect(report).toContain('## pre-existing dirty');
      expect(report).toContain('preexisting.txt');
      expect(await service.showArtifact(accepted.state.taskId, 'test-build-log')).toContain('node unsafe.js');
      expect(await service.showArtifact(accepted.state.taskId, 'test-build-log')).toContain('blocked');
      const taskRecord = await readFile(join(targetDir, 'task', accepted.state.taskId, 'task-record.md'), 'utf8');
      expect(taskRecord).toContain('中文文件读取');
      expect(taskRecord).not.toContain('\u001b[');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      heavy.planPackDraft = {
        category: 'Manager / Workflow',
        summary: 'Add universal task record storage.',
        executionUnits: [
          { name: 'Task record storage' },
          { name: 'Acceptance workflow' },
        ],
      };
      const created = await service.createTask({ title: 'Task records', task: 'Add universal task records.' });
      const planned = await planThroughBrief(service, created.state.taskId);
      const approved = await service.reply(planned.state.taskId, 'approve A');

      expect(approved.state.status).toBe('awaiting_user_acceptance');
      expect(approved.state.category).toBe('Manager / Workflow');
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
      expect(globalReadme).toContain('Manager / Workflow');
      expect(globalReadme).toContain('completed');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it.each([
    [{ route: 'route_to_implementer', reason: 'Contained bug remains.' } as ManagerRouteResult, 'implementation_approved'],
    [{ route: 'route_to_planner', reason: 'The plan missed a design constraint.' } as ManagerRouteResult, 'planning_requested'],
    [{ route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' } as ManagerRouteResult, 'waiting_user_direction'],
  ])('routes after failed final review through %s', async (route, expectedStatus) => {
    const { root, targetDir, service } = await makeService(route);
    try {
      const created = await service.createTask({ title: 'Route task', task: 'Build a feature.' });
      const planned = await planThroughBrief(service, created.state.taskId);
      const approved = await service.reply(planned.state.taskId, 'approve A');

      expect(approved.state.status).toBe(expectedStatus);
      expect(approved.message).toContain(route.reason);
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
      const planned = await planThroughBrief(service, created.state.taskId);
      const fallback = await service.reply(planned.state.taskId, '好的');

      expect(fallback.state.status).toBe('ready_for_decision');
      expect(fallback.message).toContain('请明确回复');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('pauses at awaiting_brief_confirmation before invoking heavy agents', async () => {
    const { root, targetDir, service, heavy, manager } = await makeService();
    try {
      const created = await service.createTask({ title: 'Brief gate task', task: 'Voice input task.' });
      const briefStop = await service.planTask(created.state.taskId);

      expect(briefStop.state.status).toBe('awaiting_brief_confirmation');
      expect(briefStop.state.briefConfirmed).toBe(false);
      expect(briefStop.state.revisionRound).toBe(0);
      expect(heavy.reviewerRuns).toBe(0);
      expect(manager.briefCalls).toHaveLength(1);
      expect(await service.showArtifact(briefStop.state.taskId, 'manager-brief')).toContain('需求摘要');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('pauses at awaiting_difficulty_selection after brief approval', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'Difficulty gate task', task: 'Build a feature.' });
      await service.planTask(created.state.taskId);
      const difficultyStop = await service.reply(created.state.taskId, 'approve A');

      expect(difficultyStop.state.status).toBe('awaiting_difficulty_selection');
      expect(difficultyStop.state.pendingUserPrompt).toContain('low');
      expect(difficultyStop.state.pendingUserPrompt).toContain('medium');
      expect(difficultyStop.state.pendingUserPrompt).toContain('high');
      expect(heavy.difficultyCalls).toHaveLength(0);
      expect(heavy.reviewerRuns).toBe(0);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('skips plan review and revision in low difficulty', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'Low task', task: 'Adjust copy.' });
      await service.planTask(created.state.taskId);
      await service.reply(created.state.taskId, 'approve A');
      const planned = await service.reply(created.state.taskId, 'low');

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.difficulty).toBe('low');
      expect(planned.state.reviewerRunCount).toBe(0);
      expect(heavy.reviewerRuns).toBe(0);
      expect(heavy.difficultyCalls).toEqual(['low']);

      const initialPlan = await service.showArtifact(planned.state.taskId, 'initial-plan');
      const revisedPlan = await service.showArtifact(planned.state.taskId, 'revised-plan');
      expect(revisedPlan.replace(/\n\n<!-- manager-plan-metadata[\s\S]*$/, '')).toBe(initialPlan);
      expect(revisedPlan).toContain('manager-plan-metadata');
      await expect(service.showArtifact(planned.state.taskId, 'review')).rejects.toThrow();
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('passes high difficulty through every full planning agent call', async () => {
    const { root, targetDir, service, heavy } = await makeService();
    try {
      const created = await service.createTask({ title: 'High task', task: 'Build a risky feature.' });
      await service.planTask(created.state.taskId);
      await service.reply(created.state.taskId, 'approve A');
      const planned = await service.reply(created.state.taskId, 'high');

      expect(planned.state.status).toBe('ready_for_decision');
      expect(planned.state.difficulty).toBe('high');
      expect(planned.state.reviewerRunCount).toBe(1);
      expect(heavy.reviewerRuns).toBe(1);
      expect(heavy.difficultyCalls).toEqual(['high', 'high', 'high']);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('accumulates brief revision requests across multiple revise C rounds', async () => {
    const { root, targetDir, service, manager } = await makeService();
    try {
      const created = await service.createTask({ title: 'Brief revision task', task: 'Original task.' });
      await service.planTask(created.state.taskId);
      await service.reply(created.state.taskId, 'revise C: 把 X 改成 Y');
      await service.reply(created.state.taskId, 'revise C: 再加上 Z 这个细节');
      const difficultyStop = await service.reply(created.state.taskId, 'approve A');
      expect(difficultyStop.state.status).toBe('awaiting_difficulty_selection');
      const approved = await service.reply(created.state.taskId, 'medium');

      expect(approved.state.status).toBe('ready_for_decision');
      expect(approved.state.briefConfirmed).toBe(true);
      expect(approved.state.briefRevisionRequests).toEqual(['把 X 改成 Y', '再加上 Z 这个细节']);
      expect(manager.briefCalls).toHaveLength(3);
      expect(manager.briefCalls[1]?.revisions).toEqual(['把 X 改成 Y']);
      expect(manager.briefCalls[2]?.revisions).toEqual(['把 X 改成 Y', '再加上 Z 这个细节']);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('rejects from brief gate stops the task', async () => {
    const { root, targetDir, service } = await makeService();
    try {
      const created = await service.createTask({ title: 'Brief reject task', task: 'Task body.' });
      await service.planTask(created.state.taskId);
      const stopped = await service.reply(created.state.taskId, 'reject B');

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
