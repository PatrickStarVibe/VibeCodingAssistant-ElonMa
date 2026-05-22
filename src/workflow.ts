import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ArtifactStore } from './artifacts.js';
import type { HeavyAgentAdapter, ManagerAdapter } from './adapters.js';
import { diffStatusLines, readGitSnapshot } from './git.js';
import { ProjectKnowledgeService } from './projectKnowledge.js';
import { configForProject, getDefaultProjectId, requireProject } from './projects.js';
import {
  executionModeFor,
  makeExecutionUnits,
  normalizeTaskCategory,
  resolveTaskRecordRoot,
  renderTestResult,
  TaskRecordStore,
} from './taskRecords.js';
import {
  TOKEN_USAGE_FILE_NAME,
  formatTaskUsageSummary,
  readTaskUsageLedger,
  summarizeTaskUsageLedger,
  type TaskUsageBreakdownKey,
} from './taskUsage.js';
import type { ArtifactName, ExecutionUnitState, GitSnapshot, ManagerConfig, PlanResult, TaskState, VerificationCommandResult } from './types.js';
import { renderVerificationLog, runVerificationCommands } from './verification.js';

export interface WorkflowOptions {
  executeVerification?: boolean;
}

export interface WorkflowResult {
  state: TaskState;
  message: string;
}

export class WorkflowService {
  constructor(
    private readonly store: ArtifactStore,
    private readonly config: ManagerConfig,
    private readonly manager: ManagerAdapter,
    private readonly heavyAgents: HeavyAgentAdapter,
    private readonly options: WorkflowOptions = {},
    private readonly projectKnowledge = new ProjectKnowledgeService(store.managerRoot),
    private readonly taskRecords = new TaskRecordStore(),
  ) {}

  async createTask(input: { title: string; task: string; projectId?: string }): Promise<WorkflowResult> {
    const now = new Date().toISOString();
    const taskId = makeTaskId(input.title, now);
    const project = requireProject(this.config, input.projectId ?? getDefaultProjectId(this.config));
    let state: TaskState = {
      taskId,
      title: input.title,
      projectId: project.id,
      category: 'Other',
      status: 'created',
      createdAt: now,
      updatedAt: now,
      revisionRound: 0,
      reviewerRunCount: 0,
      executionQueue: [],
      briefConfirmed: false,
      briefRevisionRequests: [],
      userAcceptanceNotes: [],
      artifacts: {},
      requestedChanges: [],
    };

    state = await this.store.writeArtifact(state, 'original-task', renderOriginalTask(input.title, input.task));
    await this.store.saveState(state);
    await this.store.writeLatest(taskId);
    await this.taskRecords.initializeParentTask({
      state,
      project,
      originalRequest: input.task,
    });
    return { state, message: `Created task ${taskId}.` };
  }

  async planTask(taskIdOrLatest: string): Promise<WorkflowResult> {
    let state = await this.store.loadState(taskIdOrLatest);
    if (!['created', 'briefing', 'awaiting_brief_confirmation', 'awaiting_difficulty_selection', 'planning_requested', 'waiting_user_direction', 'ready_for_decision'].includes(state.status)) {
      throw new Error(`Cannot run planning from state ${state.status}.`);
    }

    const task = await this.store.readArtifact(state, 'original-task');
    const project = this.projectForState(state);
    const scopedConfig = configForProject(this.config, project);

    // Phase 1: Brief generation and user confirmation gate.
    if (!state.briefConfirmed) {
      state = { ...state, status: 'briefing', updatedAt: new Date().toISOString() };
      await this.store.saveState(state);

      const projectContext = await this.buildProjectContext(state, task);
      const brief = await this.manager.createTaskBrief({
        task,
        projectContext,
        briefRevisionRequests: state.briefRevisionRequests,
        state,
        config: scopedConfig,
      });
      state = await this.store.writeArtifact(state, 'manager-brief', brief.markdown);
      await this.taskRecords.writeBrief(project, state, brief.markdown);
      state = {
        ...state,
        status: 'awaiting_brief_confirmation',
        pendingUserPrompt: 'Review the brief: approve A to choose workflow difficulty, revise C: <correction> to refine, reject B to stop.',
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveState(state);
      return { state, message: 'Brief is ready for your confirmation. Run: show --artifact manager-brief' };
    }

    if (!state.difficulty) {
      state = {
        ...state,
        status: 'awaiting_difficulty_selection',
        pendingUserPrompt: renderDifficultyPrompt(),
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveState(state);
      return { state, message: 'Brief approved. Choose a workflow difficulty: low, medium, or high.' };
    }
    const difficulty = state.difficulty;

    // Phase 2: Plan, review, revise.
    if (state.revisionRound >= this.config.maxRevisionRounds) {
      throw new Error(`Maximum revision rounds reached (${this.config.maxRevisionRounds}).`);
    }

    state = { ...state, status: 'planning', revisionRound: state.revisionRound + 1, updatedAt: new Date().toISOString() };
    await this.store.saveState(state);

    const briefMarkdown = await this.store.readArtifact(state, 'manager-brief');
    const projectContext = await this.buildProjectContext(state, [task, briefMarkdown, state.requestedChanges.join('\n')].join('\n\n'));

    const initialPlan = await this.heavyAgents.createInitialPlan({
      task,
      projectContext,
      brief: briefMarkdown,
      difficulty,
      state,
      config: scopedConfig,
    });
    state = await this.store.writeArtifact(state, 'initial-plan', initialPlan.markdown);

    if (difficulty === 'low') {
      state = await this.store.writeArtifact(state, 'revised-plan', initialPlan.markdown);
      state = await this.writePlanMetadata(state, initialPlan);

      const explanation = await this.manager.explainRevisedPlan({
        task,
        projectContext,
        revisedPlan: initialPlan.markdown,
        review: '',
        revisionInstructions: '',
        state,
        config: scopedConfig,
      });
      state = await this.store.writeArtifact(state, 'manager-explanation', explanation.markdown);
      if (explanation.needsUserDecision) {
        state = await this.pauseForUserDirection(state, explanation.userPrompt ?? explanation.markdown);
        return { state, message: 'Manager explanation needs a product-level decision.' };
      }

      state = { ...withoutPendingPrompt(state), status: 'ready_for_decision', updatedAt: new Date().toISOString() };
      await this.store.saveState(state);
      return { state, message: 'Low-difficulty plan is ready for your decision.' };
    }

    let reviewMarkdown = '';
    if (state.reviewerRunCount === 0) {
      const review = await this.heavyAgents.reviewPlan({
        task,
        projectContext,
        initialPlan: initialPlan.markdown,
        difficulty,
        state,
        config: scopedConfig,
      });
      reviewMarkdown = review.markdown;
      state = {
        ...await this.store.writeArtifact(state, 'review', reviewMarkdown),
        reviewerRunCount: state.reviewerRunCount + 1,
      };
    } else {
      reviewMarkdown = await this.store.readArtifact(state, 'review');
    }

    const revisionInstructions = await this.manager.createRevisionInstructions({
      task,
      projectContext,
      initialPlan: initialPlan.markdown,
      review: reviewMarkdown,
      requestedChanges: state.requestedChanges,
      state,
      config: scopedConfig,
    });
    state = await this.store.writeArtifact(state, 'revision-instructions', revisionInstructions.markdown);
    if (revisionInstructions.needsUserDecision) {
      state = await this.pauseForUserDirection(state, revisionInstructions.userPrompt ?? revisionInstructions.markdown);
      return { state, message: 'Manager needs a product-level decision before the plan can be revised.' };
    }

    const revisedPlan = await this.heavyAgents.revisePlan({
      task,
      projectContext,
      initialPlan: initialPlan.markdown,
      review: reviewMarkdown,
      revisionInstructions: revisionInstructions.markdown,
      difficulty,
      state,
      config: scopedConfig,
    });
    state = await this.store.writeArtifact(state, 'revised-plan', revisedPlan.markdown);
    state = await this.writePlanMetadata(state, revisedPlan);

    const explanation = await this.manager.explainRevisedPlan({
      task,
      projectContext,
      revisedPlan: revisedPlan.markdown,
      review: reviewMarkdown,
      revisionInstructions: revisionInstructions.markdown,
      state,
      config: scopedConfig,
    });
    state = await this.store.writeArtifact(state, 'manager-explanation', explanation.markdown);
    if (explanation.needsUserDecision) {
      state = await this.pauseForUserDirection(state, explanation.userPrompt ?? explanation.markdown);
      return { state, message: 'Manager explanation needs a product-level decision.' };
    }

    state = { ...withoutPendingPrompt(state), status: 'ready_for_decision', updatedAt: new Date().toISOString() };
    await this.store.saveState(state);
    return { state, message: 'Revised plan is ready for your decision.' };
  }

  async explainTask(taskIdOrLatest: string): Promise<WorkflowResult> {
    let state = await this.store.loadState(taskIdOrLatest);
    const task = await this.store.readArtifact(state, 'original-task');
    const revisedPlan = await this.requireArtifact(state, 'revised-plan', 'Cannot explain before a revised plan exists.');
    const review = await this.store.readArtifact(state, 'review').catch(() => '');
    const revisionInstructions = await this.store.readArtifact(state, 'revision-instructions').catch(() => '');
    const projectContext = await this.buildProjectContext(state, [task, revisedPlan, review, revisionInstructions].join('\n\n'));
    const explanation = await this.manager.explainRevisedPlan({
      task,
      projectContext,
      revisedPlan,
      review,
      revisionInstructions,
      state,
      config: this.configForState(state),
    });
    state = await this.store.writeArtifact(state, 'manager-explanation', explanation.markdown);
    state = explanation.needsUserDecision
      ? {
        ...state,
        status: 'waiting_user_direction',
        pendingUserPrompt: explanation.userPrompt ?? explanation.markdown,
        updatedAt: new Date().toISOString(),
      }
      : { ...withoutPendingPrompt(state), status: 'ready_for_decision', updatedAt: new Date().toISOString() };
    await this.store.saveState(state);
    return { state, message: explanation.needsUserDecision ? 'Manager needs a product-level decision.' : 'Explanation updated.' };
  }

  async askQuestion(taskIdOrLatest: string, question: string): Promise<WorkflowResult> {
    let state = await this.store.loadState(taskIdOrLatest);
    const context = await this.buildContext(state, false);
    const projectContext = await this.buildProjectContext(state, [question, context].join('\n\n'));
    const answer = await this.manager.answerQuestion({ question, context, projectContext, state, config: this.configForState(state) });
    state = await this.store.appendArtifact(state, 'qa-log', [
      `## ${new Date().toISOString()}`,
      '',
      `Q: ${question}`,
      '',
      answer,
    ].join('\n'));
    await this.store.saveState(state);
    return { state, message: answer };
  }

  async reply(taskIdOrLatest: string, reply: string): Promise<WorkflowResult> {
    let state = await this.store.loadState(taskIdOrLatest);
    const parsed = parseWorkflowReply(reply);

    if (parsed.kind === 'status') return { state, message: renderStatus(state) };
    if (parsed.kind === 'summary') return { state, message: await this.renderSummary(state) };

    if (parsed.kind === 'ambiguous') {
      if (!parsed.useLlmFallback) {
        return { state, message: `Ambiguous reply: ${parsed.reason}` };
      }
      const confirmation = await this.manager.interpretAmbiguousReply({
        reply,
        context: await this.buildContext(state),
        state,
        config: this.configForState(state),
      });
      state = await this.store.appendArtifact(state, 'decision-log', `Ambiguous reply: ${reply}\nManager confirmation: ${confirmation}`);
      await this.store.saveState(state);
      return { state, message: confirmation };
    }

    if (parsed.kind === 'difficulty') {
      if (state.status !== 'awaiting_difficulty_selection') {
        throw new Error(`Cannot choose difficulty from state ${state.status}.`);
      }
      state = {
        ...withoutPendingPrompt(state),
        status: 'planning_requested',
        difficulty: parsed.level,
        lastDecision: reply,
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', `difficulty: ${parsed.level}`);
      await this.store.saveState(state);
      return this.planTask(state.taskId);
    }

    if (parsed.kind === 'stop') {
      state = {
        ...state,
        status: 'stopped',
        stoppedReason: 'User sent stop.',
        lastDecision: reply,
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', `stop: ${reply}`);
      await this.store.saveState(state);
      return { state, message: 'Task stopped.' };
    }

    if (parsed.kind === 'reject') {
      state = {
        ...state,
        status: 'stopped',
        stoppedReason: 'User rejected the revised plan.',
        lastDecision: reply,
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', `reject B: ${reply}`);
      await this.store.saveState(state);
      return { state, message: 'Revised plan rejected; task stopped.' };
    }

    if (parsed.kind === 'note') {
      if (state.status !== 'awaiting_user_acceptance') {
        throw new Error(`Cannot record an acceptance note from state ${state.status}.`);
      }
      state = {
        ...state,
        userAcceptanceNotes: [...state.userAcceptanceNotes, parsed.note],
        lastDecision: reply,
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', `note: ${parsed.note}`);
      await this.store.saveState(state);
      await this.refreshParentTaskReadme(state, 'Awaiting user acceptance.');
      return { state, message: 'User note recorded. Task is still awaiting acceptance.' };
    }

    if (parsed.kind === 'accept') {
      if (state.status !== 'awaiting_user_acceptance') {
        throw new Error(`Cannot accept task from state ${state.status}.`);
      }
      return this.recordAcceptedTask(state, reply);
    }

    if (parsed.kind === 'revise') {
      if (state.status === 'awaiting_brief_confirmation') {
        state = {
          ...state,
          status: 'briefing',
          briefRevisionRequests: [...state.briefRevisionRequests, parsed.instruction],
          lastDecision: reply,
          updatedAt: new Date().toISOString(),
        };
        state = await this.store.appendArtifact(state, 'decision-log', `revise C (brief): ${parsed.instruction}`);
        await this.store.saveState(state);
        return this.planTask(state.taskId);
      }
      if (state.status === 'awaiting_user_acceptance') {
        state = {
          ...state,
          status: 'implementation_approved',
          requestedChanges: [...state.requestedChanges, parsed.instruction],
          userAcceptanceNotes: [...state.userAcceptanceNotes, `Revision requested: ${parsed.instruction}`],
          lastDecision: reply,
          updatedAt: new Date().toISOString(),
        };
        state = await this.store.appendArtifact(state, 'decision-log', `revise after final review: ${parsed.instruction}`);
        await this.store.saveState(state);
        await this.refreshParentTaskReadme(state, 'User requested a revision after final review.');
        return { state, message: 'User requested a revision after final review. Send approve A to run the approved implementation route again.' };
      }
      if (!['ready_for_decision', 'waiting_user_direction'].includes(state.status)) {
        throw new Error(`Cannot request revision from state ${state.status}.`);
      }
      state = {
        ...state,
        status: 'planning_requested',
        requestedChanges: [...state.requestedChanges, parsed.instruction],
        lastDecision: reply,
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', `revise C: ${parsed.instruction}`);
      await this.store.saveState(state);
      return this.planTask(state.taskId);
    }

    if (parsed.kind === 'approve') {
      if (state.status === 'awaiting_user_acceptance') {
        return this.recordAcceptedTask(state, reply);
      }
      if (state.status === 'awaiting_brief_confirmation') {
        state = {
          ...state,
          status: 'planning_requested',
          briefConfirmed: true,
          lastDecision: reply,
          updatedAt: new Date().toISOString(),
        };
        state = withoutPendingPrompt(state);
        state = await this.store.appendArtifact(state, 'decision-log', `approve A (brief): ${reply}`);
        await this.store.saveState(state);
        await this.refreshParentTaskReadme(state, 'Brief approved. Planning not finalized yet.');
        return this.planTask(state.taskId);
      }
      if (state.status === 'implementation_approved') {
        return this.implementApproved(state.taskId);
      }
      if (state.status !== 'ready_for_decision' && state.status !== 'waiting_user_direction') {
        throw new Error(`Cannot approve implementation from state ${state.status}.`);
      }
      state = await this.persistApprovedTaskArtifacts(state);
      state = {
        ...withoutPendingPrompt(state),
        status: 'implementation_approved',
        approvedAt: new Date().toISOString(),
        lastDecision: reply,
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', `approve A: ${reply}`);
      await this.store.saveState(state);
      return this.implementApproved(state.taskId);
    }

    return { state, message: 'No action taken.' };
  }

  async implementApproved(taskIdOrLatest: string): Promise<WorkflowResult> {
    let state = await this.store.loadState(taskIdOrLatest);
    if (state.status !== 'implementation_approved') {
      throw new Error(`Cannot implement before approval. Current state: ${state.status}.`);
    }
    const task = await this.store.readArtifact(state, 'original-task');
    const revisedPlan = await this.requireArtifact(state, 'revised-plan', 'Cannot implement before a revised plan exists.');
    const planMetadata = readPlanMetadata(revisedPlan);
    const scopedConfig = this.configForState(state);
    const projectContext = await this.buildProjectContext(state, [task, revisedPlan].join('\n\n'));
    const preGit = await readGitSnapshot(scopedConfig.workspace.targetDir);

    state = await this.store.writeArtifact(state, 'git-pre-status', preGit.statusShort ? `${preGit.statusShort}\n` : '');
    state = await this.store.writeArtifact(state, 'git-pre-diff', preGit.diff);
    state = { ...state, status: 'implementing', currentExecutionIndex: 0, updatedAt: new Date().toISOString() };
    await this.store.saveState(state);

    const executionQueue = state.executionQueue.length > 0 ? state.executionQueue : makeExecutionUnits(undefined);
    state = { ...state, executionQueue, executionMode: executionModeFor(executionQueue), updatedAt: new Date().toISOString() };
    await this.store.saveState(state);

    const verificationRuns: Array<{ unit: ExecutionUnitState; results: VerificationCommandResult[] }> = [];
    for (const unit of executionQueue) {
      state = await this.updateExecutionUnit(state, unit.index, 'In Progress');
      state = { ...state, status: 'execution_unit_implementing', currentExecutionIndex: unit.index - 1, updatedAt: new Date().toISOString() };
      await this.store.saveState(state);
      await this.refreshParentTaskReadme(state, `Implementing execution unit ${unit.index}/${executionQueue.length}.`);

      const activeUnit = state.executionQueue[unit.index - 1] ?? unit;
      const implementation = await this.heavyAgents.implement({
        task,
        projectContext,
        revisedPlan,
        executionUnit: activeUnit,
        state,
        config: scopedConfig,
      });
      const implementationSection = [
        `## Execution Unit ${String(activeUnit.index).padStart(2, '0')}: ${activeUnit.name}`,
        '',
        implementation.markdown,
      ].join('\n');
      state = await this.store.appendArtifact(state, 'implementation-log', implementationSection);
      await this.taskRecords.appendImplementationLog(this.projectForState(state), state, implementationSection);

      state = { ...state, status: 'execution_unit_testing', updatedAt: new Date().toISOString() };
      await this.store.saveState(state);
      const verification = await runVerificationCommands(
        planMetadata.verificationCommands,
        this.config.verification.allowlist,
        scopedConfig.workspace.targetDir,
        this.options.executeVerification ?? true,
      );
      verificationRuns.push({ unit: activeUnit, results: verification });
      state = await this.store.appendArtifact(state, 'test-build-log', [
        `# Execution Unit ${String(activeUnit.index).padStart(2, '0')}: ${activeUnit.name}`,
        '',
        renderVerificationLog(verification),
      ].join('\n'));

      state = { ...state, status: 'execution_unit_result_recording', updatedAt: new Date().toISOString() };
      await this.store.saveState(state);
      const testResult = renderTestResult(verification);
      state = await this.updateExecutionUnit(state, activeUnit.index, 'Done', testResult);
      await this.taskRecords.markExecutionUnit(this.projectForState(state), state, state.executionQueue[activeUnit.index - 1] ?? activeUnit, 'Done', testResult);
      state = { ...state, status: 'next_execution_unit_or_all_done', updatedAt: new Date().toISOString() };
      await this.store.saveState(state);
      await this.refreshParentTaskReadme(state, `${activeUnit.name} completed.`);
    }

    const postGit = await readGitSnapshot(scopedConfig.workspace.targetDir);
    state = await this.store.writeArtifact(state, 'git-post-status', postGit.statusShort ? `${postGit.statusShort}\n` : '');
    state = await this.store.writeArtifact(state, 'git-post-diff', postGit.diff);
    const stateWithoutCurrentExecution = { ...state };
    delete stateWithoutCurrentExecution.currentExecutionIndex;
    state = { ...stateWithoutCurrentExecution, status: 'implemented', updatedAt: new Date().toISOString() };
    await this.store.saveState(state);
    await this.refreshParentTaskReadme(state, renderExecutionTestSummary(verificationRuns));

    return this.finalReview(state.taskId, preGit, postGit);
  }

  async finalReview(taskIdOrLatest: string, _preGit?: GitSnapshot, _postGit?: GitSnapshot): Promise<WorkflowResult> {
    let state = await this.store.loadState(taskIdOrLatest);
    if (state.status !== 'implemented') {
      throw new Error(`Cannot run final review before implementation. Current state: ${state.status}.`);
    }
    state = { ...state, status: 'final_reviewing', updatedAt: new Date().toISOString() };
    await this.store.saveState(state);

    const task = await this.store.readArtifact(state, 'original-task');
    const revisedPlan = await this.requireArtifact(state, 'revised-plan', 'Cannot final review before a revised plan exists.');
    const implementationLog = await this.requireArtifact(state, 'implementation-log', 'Cannot final review before implementation log exists.');
    const verificationLog = await this.requireArtifact(state, 'test-build-log', 'Cannot final review before verification log exists.');
    const projectContext = await this.buildProjectContext(state, [task, revisedPlan, implementationLog, verificationLog].join('\n\n'));
    const finalReview = await this.heavyAgents.finalReview({
      task,
      projectContext,
      revisedPlan,
      implementationLog,
      verificationLog,
      state,
      config: this.configForState(state),
    });
    state = await this.store.writeArtifact(state, 'final-review', finalReview.markdown);
    await this.taskRecords.writeFinalReview(this.projectForState(state), state, finalReview.markdown);

    const route = await this.manager.routeAfterFinalReview({
      finalReview: finalReview.markdown,
      verificationLog,
      state,
      config: this.configForState(state),
    });
    state = { ...state, status: 'final_review_routing', lastDecision: route.route, updatedAt: new Date().toISOString() };
    await this.store.saveState(state);

    if (route.route === 'complete') {
      state = {
        ...state,
        status: 'awaiting_user_acceptance',
        pendingUserPrompt: "等你验收：直接说'验收通过'/'accept'即可生成 task-record。",
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveState(state);
      await this.refreshParentTaskReadme(state, `Final review route: complete. ${route.reason}`);
      return { state, message: 'Final review passed. Awaiting user acceptance before task recording and completion.' };
    }

    if (route.route === 'route_to_implementer') {
      state = {
        ...state,
        status: 'implementation_approved',
        pendingUserPrompt: route.reason,
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveState(state);
      return { state, message: `Manager routed back to implementation: ${route.reason}` };
    }

    if (route.route === 'route_to_planner') {
      state = {
        ...state,
        status: 'planning_requested',
        requestedChanges: [...state.requestedChanges, route.reason],
        pendingUserPrompt: route.reason,
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveState(state);
      return { state, message: `Manager routed back to planning: ${route.reason}` };
    }

    state = await this.pauseForUserDirection(state, route.userPrompt ?? route.reason);
    const prompt = route.userPrompt ? `${route.reason}\n${route.userPrompt}` : route.reason;
    return { state, message: `Manager needs your decision: ${prompt}` };
  }

  async showArtifact(taskIdOrLatest: string, artifact: ArtifactName): Promise<string> {
    const state = await this.store.loadState(taskIdOrLatest);
    return this.store.readArtifact(state, artifact);
  }

  async status(taskIdOrLatest: string): Promise<string> {
    return renderStatus(await this.store.loadState(taskIdOrLatest));
  }

  async summary(taskIdOrLatest: string): Promise<string> {
    return this.renderSummary(await this.store.loadState(taskIdOrLatest));
  }

  async usage(taskIdOrLatest: string, by?: TaskUsageBreakdownKey): Promise<string> {
    return this.renderTaskUsage(await this.store.loadState(taskIdOrLatest), by);
  }

  private async pauseForUserDirection(state: TaskState, prompt: string): Promise<TaskState> {
    const next = {
      ...state,
      status: 'waiting_user_direction' as const,
      pendingUserPrompt: prompt,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveState(next);
    return next;
  }

  private async writePlanMetadata(state: TaskState, plan: PlanResult): Promise<TaskState> {
    return this.store.appendArtifact(state, 'revised-plan', [
      '',
      '<!-- manager-plan-metadata',
      JSON.stringify({
        verificationCommands: plan.verificationCommands,
        planPackDraft: plan.planPackDraft,
      }, null, 2),
      'manager-plan-metadata -->',
    ].join('\n'));
  }

  private async requireArtifact(state: TaskState, artifact: ArtifactName, message: string): Promise<string> {
    if (!state.artifacts[artifact]) throw new Error(message);
    return this.store.readArtifact(state, artifact);
  }

  private projectForState(state: TaskState) {
    return requireProject(this.config, state.projectId ?? getDefaultProjectId(this.config));
  }

  private configForState(state: TaskState): ManagerConfig {
    return configForProject(this.config, this.projectForState(state));
  }

  private async buildProjectContext(state: TaskState, query: string): Promise<string> {
    return this.projectKnowledge.buildContextPacket(this.config, {
      projectId: state.projectId ?? getDefaultProjectId(this.config),
      query,
    });
  }

  private async buildContext(state: TaskState, includeProjectContext = true): Promise<string> {
    const names: ArtifactName[] = [
      'original-task',
      'manager-brief',
      'initial-plan',
      'review',
      'revision-instructions',
      'revised-plan',
      'manager-explanation',
      'qa-log',
      'decision-log',
    ];
    const sections: string[] = [];
    if (includeProjectContext) {
      sections.push(await this.buildProjectContext(state, state.title));
    }
    sections.push(`State: ${JSON.stringify({ ...state, artifacts: undefined }, null, 2)}`);
    for (const name of names) {
      if (!state.artifacts[name]) continue;
      const content = await this.store.readArtifact(state, name).catch(() => '');
      if (content) sections.push(`## ${name}\n${content}`);
    }
    sections.push(`## token-usage\n${await this.renderTaskUsage(state)}`);
    return sections.join('\n\n');
  }

  private async renderTaskUsage(state: TaskState, by?: TaskUsageBreakdownKey): Promise<string> {
    const project = this.projectForState(state);
    const usagePath = join(resolveTaskRecordRoot(project), state.taskId, TOKEN_USAGE_FILE_NAME);
    const ledger = await readTaskUsageLedger(usagePath).catch(() => undefined);
    if (!ledger) {
      return `No ${TOKEN_USAGE_FILE_NAME} ledger is available for task ${state.taskId}.`;
    }
    return formatTaskUsageSummary(summarizeTaskUsageLedger(ledger, {
      usagePath,
      ...(by ? { by } : {}),
    }));
  }

  private async renderSummary(state: TaskState): Promise<string> {
    const lines = [
      `Task: ${state.title}`,
      `Task ID: ${state.taskId}`,
      `Status: ${state.status}`,
      `Category: ${state.category}`,
      state.executionMode ? `Execution mode: ${state.executionMode}` : undefined,
      state.difficulty ? `Difficulty: ${state.difficulty}` : undefined,
      `Revision round: ${state.revisionRound}`,
      `Reviewer runs: ${state.reviewerRunCount}`,
    ];
    if (state.pendingUserPrompt) lines.push(`Pending user prompt: ${state.pendingUserPrompt}`);
    if (state.artifacts['manager-explanation']) {
      lines.push('', '## Latest Manager Explanation', await this.store.readArtifact(state, 'manager-explanation'));
    }
    if (state.artifacts['final-report']) {
      lines.push('', '## Final Report', await this.store.readArtifact(state, 'final-report'));
    }
    return lines.join('\n');
  }

  private async persistApprovedTaskArtifacts(state: TaskState): Promise<TaskState> {
    let next: TaskState = { ...state, status: 'task_artifacts_persisting', updatedAt: new Date().toISOString() };
    await this.store.saveState(next);

    const project = this.projectForState(next);
    const revisedPlan = await this.requireArtifact(next, 'revised-plan', 'Cannot approve before a revised plan exists.');
    const review = await this.store.readArtifact(next, 'review').catch(() => '');
    const metadata = readPlanMetadata(revisedPlan);
    const category = normalizeTaskCategory(metadata.planPackDraft?.category);
    const approvedPlanInput = {
      state: next,
      project,
      planMarkdown: stripPlanMetadata(revisedPlan),
      reviewMarkdown: review,
      ...(metadata.planPackDraft?.executionUnits ? { executionUnitDrafts: metadata.planPackDraft.executionUnits } : {}),
    };
    const units = await this.taskRecords.persistApprovedPlan(approvedPlanInput);

    next = {
      ...next,
      category,
      executionQueue: units,
      executionMode: executionModeFor(units),
      planSummary: metadata.planPackDraft?.summary ?? summarizePlan(revisedPlan),
      status: 'execution_queue_ready',
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveState(next);
    await this.refreshParentTaskReadme(next, 'Execution queue is ready.');
    return next;
  }

  private async updateExecutionUnit(
    state: TaskState,
    index: number,
    status: ExecutionUnitState['status'],
    testResult?: string,
  ): Promise<TaskState> {
    return {
      ...state,
      executionQueue: state.executionQueue.map((unit) => (
        unit.index === index
          ? { ...unit, status, ...(testResult ? { testResult } : {}) }
          : unit
      )),
      updatedAt: new Date().toISOString(),
    };
  }

  private async refreshParentTaskReadme(state: TaskState, queueSummary?: string): Promise<void> {
    const project = this.projectForState(state);
    const originalRequest = await this.store.readArtifact(state, 'original-task').catch(() => '');
    const input = {
      state,
      project,
      originalRequest,
      ...(state.planSummary ? { planSummary: state.planSummary } : {}),
      ...(queueSummary ? { queueSummary } : {}),
      ...(state.artifacts['test-build-log'] ? { testSummary: 'See `test-build-log.md` and subtask Test Result sections.' } : {}),
      ...(state.artifacts['final-review'] ? { finalReviewStatus: 'Final review recorded.' } : {}),
      ...(state.acceptedAt ? { userAcceptanceStatus: `Accepted at ${state.acceptedAt}.` } : {}),
      ...(state.status === 'completed' ? { finalCompletionStatus: 'Completed.' } : {}),
    };
    await this.taskRecords.writeParentReadme(input);
    await this.taskRecords.updateGlobalReadme(project, state);
  }

  private async recordAcceptedTask(state: TaskState, reply: string): Promise<WorkflowResult> {
    let next: TaskState = {
      ...withoutPendingPrompt(state),
      status: 'task_recording',
      acceptedAt: new Date().toISOString(),
      lastDecision: reply,
      updatedAt: new Date().toISOString(),
    };
    next = await this.store.appendArtifact(next, 'decision-log', `accept: ${reply}`);
    await this.store.saveState(next);

    const project = this.projectForState(next);
    const before = {
      statusShort: await this.store.readArtifact(next, 'git-pre-status').catch(() => ''),
      diff: await this.store.readArtifact(next, 'git-pre-diff').catch(() => ''),
    };
    const after = {
      statusShort: await this.store.readArtifact(next, 'git-post-status').catch(() => ''),
      diff: await this.store.readArtifact(next, 'git-post-diff').catch(() => ''),
    };
    const report = await this.renderFinalReport(next, 'User accepted final review result.', before, after);
    next = await this.store.writeArtifact(next, 'final-report', report);
    await this.taskRecords.finalizeTaskRecord({
      state: next,
      project,
      originalRequest: await this.store.readArtifact(next, 'original-task').catch(() => ''),
      implementationLog: await this.store.readArtifact(next, 'implementation-log').catch(() => ''),
      verificationLog: await this.store.readArtifact(next, 'test-build-log').catch(() => ''),
      finalReview: await this.store.readArtifact(next, 'final-review').catch(() => ''),
      beforeStatus: before.statusShort,
      afterStatus: after.statusShort,
    });
    if (!await this.taskRecords.hasValidTaskRecord(project, next)) {
      throw new Error('Cannot complete task without a valid task-record.md.');
    }
    next = { ...next, status: 'completed', updatedAt: new Date().toISOString() };
    await this.store.saveState(next);
    await this.refreshParentTaskReadme(next, 'All execution units are done.');
    return { state: next, message: 'Task accepted, task-record.md finalized, and task completed.' };
  }

  private async renderFinalReport(
    state: TaskState,
    managerReason: string,
    before: GitSnapshot,
    after: GitSnapshot,
  ): Promise<string> {
    const implementationLog = await this.store.readArtifact(state, 'implementation-log').catch(() => '');
    const verificationLog = await this.store.readArtifact(state, 'test-build-log').catch(() => '');
    const finalReview = await this.store.readArtifact(state, 'final-review').catch(() => '');
    const newStatusLines = diffStatusLines(before, after);

    return [
      '# Final Report',
      '',
      `Task: ${state.title}`,
      `Task ID: ${state.taskId}`,
      `Manager final route: complete`,
      `Manager reason: ${managerReason}`,
      '',
      '## 本次 implementation 产生的 diff',
      '',
      newStatusLines.length > 0 ? newStatusLines.join('\n') : 'No new git status entries relative to the pre-implementation snapshot.',
      '',
      'Post-implementation diff is stored in the `git-post-diff` artifact. If a file was dirty before implementation and changed again, compare it with `git-pre-diff` for line-level separation.',
      '',
      '## pre-existing dirty',
      '',
      before.statusShort.trim() || 'No pre-existing dirty files were recorded before implementation.',
      '',
      '## Implementation Log',
      '',
      implementationLog,
      '',
      '## Test/Build Log',
      '',
      verificationLog,
      '',
      '## Final Review',
      '',
      finalReview,
      '',
    ].join('\n');
  }
}

type ParsedWorkflowReply =
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'revise'; instruction: string }
  | { kind: 'difficulty'; level: 'low' | 'medium' | 'high' }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'summary' }
  | { kind: 'accept' }
  | { kind: 'note'; note: string }
  | { kind: 'ambiguous'; reason: string; useLlmFallback: boolean };

function parseWorkflowReply(input: string): ParsedWorkflowReply {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) return { kind: 'ambiguous', reason: 'Empty reply.', useLlmFallback: false };

  if (/^status$/i.test(text)) return { kind: 'status' };
  if (/^summary$/i.test(text)) return { kind: 'summary' };
  if (/^stop$/i.test(text)) return { kind: 'stop' };
  if (/^(?:accept|accepted)$/i.test(text)) return { kind: 'accept' };
  if (/^low$/i.test(text)) return { kind: 'difficulty', level: 'low' };
  if (/^medium$/i.test(text)) return { kind: 'difficulty', level: 'medium' };
  if (/^high$/i.test(text)) return { kind: 'difficulty', level: 'high' };
  if (/^(?:approve A|approve|approved|A|yes|y)$/i.test(text)) return { kind: 'approve' };
  if (/^(?:reject B|reject|B|no|n)$/i.test(text)) return { kind: 'reject' };

  const noteMatch = text.match(/^note\s*:\s*(.+)$/i);
  if (noteMatch?.[1]?.trim()) return { kind: 'note', note: noteMatch[1].trim() };

  const reviseMatch = text.match(/^(?:revise\s+c|revise|c)\s*:\s*(.+)$/i);
  if (reviseMatch?.[1]?.trim()) return { kind: 'revise', instruction: reviseMatch[1].trim() };

  if (/^(?:revise\s+c|revise|c)$/i.test(text)) {
    return {
      kind: 'ambiguous',
      reason: 'Revision replies must include instructions after a colon, for example: revise C: keep the MVP smaller.',
      useLlmFallback: false,
    };
  }

  return { kind: 'ambiguous', reason: 'Reply did not match an internal workflow reply.', useLlmFallback: true };
}

export function renderStatus(state: TaskState): string {
  return [
    `Task ID: ${state.taskId}`,
    `Title: ${state.title}`,
    `Status: ${state.status}`,
    `Category: ${state.category}`,
    state.executionMode ? `Execution mode: ${state.executionMode}` : undefined,
    state.difficulty ? `Difficulty: ${state.difficulty}` : undefined,
    `Revision round: ${state.revisionRound}`,
    `Reviewer runs: ${state.reviewerRunCount}`,
    state.pendingUserPrompt ? `Pending user prompt: ${state.pendingUserPrompt}` : undefined,
  ].filter(Boolean).join('\n');
}

function renderDifficultyPrompt(): string {
  return [
    'Choose workflow difficulty:',
    '- low: simple copy, text, color, or tiny changes. Skips plan review and revision.',
    '- medium: default flow. Codex plans, Claude reviews, Codex revises.',
    '- high: complex or risky work. Claude plans/revises, Codex reviews the plan.',
    'Reply with exactly one of: low, medium, high.',
  ].join('\n');
}

function makeTaskId(title: string, iso: string): string {
  const slug = title
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
  const stamp = iso.replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${slug}`;
}

function renderOriginalTask(title: string, task: string): string {
  return [`# ${title}`, '', task.trim(), ''].join('\n');
}

function withoutPendingPrompt(state: TaskState): TaskState {
  const { pendingUserPrompt: _pendingUserPrompt, ...rest } = state;
  return rest;
}

function readPlanMetadata(revisedPlan: string): { verificationCommands: string[]; planPackDraft?: PlanResult['planPackDraft'] } {
  const match = revisedPlan.match(/<!-- manager-plan-metadata\s*([\s\S]*?)\s*manager-plan-metadata -->/);
  if (!match?.[1]) return { verificationCommands: [] };
  try {
    const payload = JSON.parse(match[1]) as { verificationCommands?: unknown; planPackDraft?: PlanResult['planPackDraft'] };
    const metadata: { verificationCommands: string[]; planPackDraft?: PlanResult['planPackDraft'] } = {
      verificationCommands: Array.isArray(payload.verificationCommands)
        ? payload.verificationCommands.filter((command): command is string => typeof command === 'string')
        : [],
    };
    if (payload.planPackDraft) metadata.planPackDraft = payload.planPackDraft;
    return metadata;
  } catch {
    return { verificationCommands: [] };
  }
}

function stripPlanMetadata(markdown: string): string {
  return markdown.replace(/\n*<!-- manager-plan-metadata[\s\S]*?manager-plan-metadata -->\s*$/m, '').trim();
}

function summarizePlan(markdown: string): string {
  const stripped = stripPlanMetadata(markdown);
  const firstParagraph = stripped
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find((paragraph) => paragraph.length > 0 && !paragraph.startsWith('#') && !paragraph.startsWith('|'));
  return firstParagraph ?? 'Approved plan persisted.';
}

function renderExecutionTestSummary(runs: Array<{ unit: ExecutionUnitState; results: VerificationCommandResult[] }>): string {
  if (runs.length === 0) return 'No execution-unit verification was recorded.';
  return runs.map(({ unit, results }) => {
    const status = results.length === 0
      ? 'no commands'
      : results.map((result) => `${result.command}: ${result.status}`).join(', ');
    return `Task ${String(unit.index).padStart(2, '0')} ${unit.name}: ${status}`;
  }).join('\n');
}

export async function taskTextFromFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
