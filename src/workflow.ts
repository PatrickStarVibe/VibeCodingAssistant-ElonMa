import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ArtifactStore } from './artifacts.js';
import { buildInitialPlanPrompt, HeavyAgentArtifactError, usesBlockerLedger, type HeavyAgentAdapter, type AssistantAdapter } from './adapters.js';
import {
  activeBlockers,
  applyArchitectResponses,
  applyReviewerOutput,
  renderBlockerLedgerArtifact,
  renderLedgerForArchitectPrompt,
  renderLedgerForReviewerPrompt,
  renderRoundLedgerSnapshot,
  renderUnclosedBlockerSummary,
  validateArchitectResponsesAgainstLedger,
  validateReviewerOutputAgainstLedger,
} from './blockerLedger.js';
import { normalizeWorkflowDifficulty, WORKFLOW_DIFFICULTIES } from './difficulty.js';
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
import type {
  AgentPromptRecord,
  ArtifactName,
  ExecutionUnitState,
  GitSnapshot,
  AssistantConfig,
  AssistantRouteResult,
  BlockerLedger,
  PlanResult,
  ReviewResult,
  TaskState,
  VerificationCommandResult,
  WorkflowDifficulty,
  PendingUserDecision,
  PendingUserDecisionOption,
  PendingUserDecisionSource,
} from './types.js';
import {
  normalizePendingUserDecision,
  renderInvalidUserDecisionPause,
  renderPendingUserDecision,
  renderUserDirectionForPlanner,
  renderUserDirectionLog,
  selectedDecisionOption,
} from './userDecision.js';
import { renderVerificationLog, runVerificationCommands } from './verification.js';

export interface WorkflowOptions {
  executeVerification?: boolean;
  orchestratorEnabled?: boolean;
}

export interface WorkflowResult {
  state: TaskState;
  message: string;
}

const MAX_EXTRA_HIGH_PLANNING_ROUNDS = 3;
const MAX_AUTOMATIC_FINAL_REVIEW_FOLLOWUP_ROUNDS = 1;
const EXTRA_HIGH_APPROVED_NEXT_ROUND_DIRECTIVE = 'n/a - approved';
const EXTRA_HIGH_CAP_NEXT_ROUND_DIRECTIVE = 'n/a - active blocker ledger recorded; user direction required';
const REVIEWER_AUTHORITATIVE_NEXT_ROUND_DIRECTIVE = 'Close every active Reviewer blocker ID in the next revised plan.';

type ExtraHighCompletedLoopResult = {
  state: TaskState;
  finalPlan: PlanResult;
  finalReview: string;
  finalNextRoundDirective: string;
  rounds: number;
  capHitWithIssues: boolean;
};

type ExtraHighPausedLoopResult = {
  state: TaskState;
  paused: true;
  message: string;
};

type ExtraHighLoopResult = ExtraHighCompletedLoopResult | ExtraHighPausedLoopResult;

type PlanRoundVerdict = 'approved' | 'revision_requested' | 'issues_remain';

export class WorkflowService {
  constructor(
    private readonly store: ArtifactStore,
    private readonly config: AssistantConfig,
    private readonly assistant: AssistantAdapter,
    private readonly heavyAgents: HeavyAgentAdapter,
    private readonly options: WorkflowOptions = {},
    private readonly projectKnowledge = new ProjectKnowledgeService(store.assistantRoot),
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
    if (!['created', 'awaiting_difficulty_selection', 'planning_requested', 'waiting_user_direction', 'ready_for_decision'].includes(state.status)) {
      throw new Error(`Cannot run planning from state ${state.status}.`);
    }

    const task = await this.store.readArtifact(state, 'original-task');
    const project = this.projectForState(state);
    const scopedConfig = configForProject(this.config, project);

    if (!state.difficulty) {
      state = {
        ...withoutPendingPrompt(state),
        status: 'awaiting_difficulty_selection',
        pendingUserPrompt: renderDifficultyPrompt(),
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveState(state);
      return { state, message: 'Choose a workflow difficulty: low, medium, high, or extra high.' };
    }
    const difficulty = state.difficulty;

    // Phase 2: Plan, review, revise.
    if (difficulty !== 'extra-high' && state.revisionRound >= this.config.maxRevisionRounds) {
      throw new Error(`Maximum revision rounds reached (${this.config.maxRevisionRounds}).`);
    }

    state = { ...state, status: 'planning', revisionRound: state.revisionRound + 1, updatedAt: new Date().toISOString() };
    await this.store.saveState(state);

    const projectContext = await this.buildProjectContext(state, [task, state.requestedChanges.join('\n')].filter(Boolean).join('\n\n'));

    if (difficulty === 'extra-high') {
      const loop = await this.runExtraHighPlanningLoop(state, task, projectContext, scopedConfig);
      if ('paused' in loop) return { state: loop.state, message: loop.message };

      state = loop.state;
      state = await this.writePlanMetadata(state, loop.finalPlan);

      const explanation = await this.assistant.explainRevisedPlan({
        task,
        projectContext,
        revisedPlan: loop.finalPlan.markdown,
        review: loop.finalReview,
        state,
        config: scopedConfig,
      });
      state = await this.store.writeArtifact(state, 'assistant-explanation', explanation.markdown);

      state = { ...withoutPendingPrompt(state), status: 'ready_for_decision', updatedAt: new Date().toISOString() };
      await this.store.saveState(state);
      return { state, message: 'Revised plan is ready for your decision.' };
    }

    const initialPlanResult = await this.runPlanAgent(state, 'initial plan', () => this.heavyAgents.createInitialPlan({
      task,
      projectContext,
      difficulty,
      state,
      config: scopedConfig,
    }));
    if (!initialPlanResult.ok) return { state: initialPlanResult.state, message: initialPlanResult.message };
    const initialPlan = initialPlanResult.plan;
    state = await this.appendAgentPrompt(state, initialPlan.agentPrompt);
    if (initialPlan.decisionParseError) {
      state = await this.pauseForInvalidAgentDecision(state, 'architect_plan', initialPlan.decisionParseError, initialPlan.markdown);
      return { state, message: state.pendingUserPrompt ?? 'Architect output needs a valid structured user decision block.' };
    }
    state = await this.store.writeArtifact(state, 'initial-plan', initialPlan.markdown);
    if (initialPlan.userDecision) {
      state = await this.pauseForAgentDecision(state, 'architect_plan', initialPlan.userDecision);
      return { state, message: state.pendingUserPrompt ?? 'Architect needs a user decision before planning can continue.' };
    }

    if (difficulty === 'low') {
      state = await this.store.writeArtifact(state, 'revised-plan', initialPlan.markdown);
      state = await this.writePlanMetadata(state, initialPlan);

      const explanation = await this.assistant.explainRevisedPlan({
        task,
        projectContext,
        revisedPlan: initialPlan.markdown,
        review: '',
        state,
        config: scopedConfig,
      });
      state = await this.store.writeArtifact(state, 'assistant-explanation', explanation.markdown);

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
        ...(usesBlockerLedger(difficulty) && state.blockerLedger ? { blockerLedgerText: renderLedgerForReviewerPrompt(state.blockerLedger) } : {}),
      });
      reviewMarkdown = review.markdown;
      state = await this.appendAgentPrompt(state, review.agentPrompt);
      const reviewRound = state.reviewerRunCount + 1;
      state = {
        ...await this.store.writeArtifact(state, 'review', reviewMarkdown),
        reviewerRunCount: reviewRound,
      };
      if (review.decisionParseError) {
        state = await this.pauseForInvalidAgentDecision(state, 'plan_review', review.decisionParseError, review.markdown);
        return { state, message: state.pendingUserPrompt ?? 'Plan Reviewer output needs a valid structured user decision block.' };
      }
      const reviewerLedger = await this.applyReviewerLedgerOrPause(state, review, difficulty, reviewRound);
      if (reviewerLedger.paused) return { state: reviewerLedger.state, message: reviewerLedger.message };
      state = reviewerLedger.state;
      if (review.userDecision) {
        state = await this.pauseForAgentDecision(state, 'plan_review', review.userDecision);
        return { state, message: state.pendingUserPrompt ?? 'Plan Reviewer needs a user decision before revise can continue.' };
      }
    } else {
      reviewMarkdown = await this.store.readArtifact(state, 'review');
    }

    const revisedPlanResult = await this.runPlanAgent(state, 'revised plan', () => this.heavyAgents.revisePlan({
      task,
      projectContext,
      initialPlan: initialPlan.markdown,
      review: reviewMarkdown,
      requestedChanges: state.requestedChanges,
      difficulty,
      state,
      config: scopedConfig,
      ...(usesBlockerLedger(difficulty) && state.blockerLedger ? { blockerLedgerText: renderLedgerForArchitectPrompt(state.blockerLedger) } : {}),
    }));
    if (!revisedPlanResult.ok) return { state: revisedPlanResult.state, message: revisedPlanResult.message };
    const revisedPlan = revisedPlanResult.plan;
    state = await this.appendAgentPrompt(state, revisedPlan.agentPrompt);
    if (revisedPlan.decisionParseError) {
      state = await this.pauseForInvalidAgentDecision(state, 'architect_plan', revisedPlan.decisionParseError, revisedPlan.markdown);
      return { state, message: state.pendingUserPrompt ?? 'Architect output needs a valid structured user decision block.' };
    }
    const architectLedger = await this.applyArchitectLedgerOrPause(state, revisedPlan, difficulty, state.revisionRound);
    if (architectLedger.paused) return { state: architectLedger.state, message: architectLedger.message };
    state = architectLedger.state;
    if (hasArchitectNeedsUserDecision(revisedPlan) && !revisedPlan.userDecision) {
      state = await this.pauseForInvalidBlockerOutput(state, 'Architect', 'architect response status needs_user_decision requires an assistant-user-decision block');
      return { state, message: state.pendingUserPrompt ?? 'Architect blocker response needs a structured user decision block.' };
    }
    if (revisedPlan.userDecision) {
      state = await this.pauseForAgentDecision(state, 'architect_plan', revisedPlan.userDecision);
      return { state, message: state.pendingUserPrompt ?? 'Architect needs a user decision before planning can continue.' };
    }
    state = await this.store.writeArtifact(state, 'revised-plan', revisedPlan.markdown);
    state = await this.writePlanMetadata(state, revisedPlan);

    const explanation = await this.assistant.explainRevisedPlan({
      task,
      projectContext,
      revisedPlan: revisedPlan.markdown,
      review: reviewMarkdown,
      state,
      config: scopedConfig,
    });
    state = await this.store.writeArtifact(state, 'assistant-explanation', explanation.markdown);

    state = { ...withoutPendingPrompt(state), status: 'ready_for_decision', updatedAt: new Date().toISOString() };
    await this.store.saveState(state);
    return { state, message: 'Revised plan is ready for your decision.' };
  }

  async explainTask(taskIdOrLatest: string): Promise<WorkflowResult> {
    let state = await this.store.loadState(taskIdOrLatest);
    const task = await this.store.readArtifact(state, 'original-task');
    const revisedPlan = await this.requireArtifact(state, 'revised-plan', 'Cannot explain before a revised plan exists.');
    const review = await this.store.readArtifact(state, 'review').catch(() => '');
    const projectContext = await this.buildProjectContext(state, [task, revisedPlan, review].join('\n\n'));
    const explanation = await this.assistant.explainRevisedPlan({
      task,
      projectContext,
      revisedPlan,
      review,
      state,
      config: this.configForState(state),
    });
    state = await this.store.writeArtifact(state, 'assistant-explanation', explanation.markdown);
    state = { ...withoutPendingPrompt(state), status: 'ready_for_decision', updatedAt: new Date().toISOString() };
    await this.store.saveState(state);
    return {
      state,
      message: 'Explanation updated.',
    };
  }

  async askQuestion(taskIdOrLatest: string, question: string): Promise<WorkflowResult> {
    let state = await this.store.loadState(taskIdOrLatest);
    const context = await this.buildContext(state, false);
    const projectContext = await this.buildProjectContext(state, [question, context].join('\n\n'));
    const answer = await this.assistant.answerQuestion({ question, context, projectContext, state, config: this.configForState(state) });
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
    const confirmation = await this.assistant.interpretAmbiguousReply({
        reply,
        context: await this.buildContext(state),
        state,
        config: this.configForState(state),
      });
    state = await this.store.appendArtifact(state, 'decision-log', `Ambiguous reply: ${reply}\nAssistant confirmation: ${confirmation}`);
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
      state = appendWorkflowInstruction(state, parsed.instruction);
      state = await this.store.appendArtifact(
        state,
        'decision-log',
        [`difficulty: ${parsed.level}`, parsed.instruction ? `Instruction: ${parsed.instruction}` : undefined].filter(Boolean).join('\n'),
      );
      await this.store.saveState(state);
      return this.planTask(state.taskId);
    }

    if (parsed.kind === 'stop') {
      state = clearFollowupScope({
        ...state,
        status: 'stopped',
        stoppedReason: 'User sent stop.',
        lastDecision: reply,
        updatedAt: new Date().toISOString(),
      });
      state = await this.store.appendArtifact(state, 'decision-log', `stop: ${reply}`);
      await this.store.saveState(state);
      return { state, message: 'Task stopped.' };
    }

    if (parsed.kind === 'reject') {
      state = clearFollowupScope({
        ...state,
        status: 'stopped',
        stoppedReason: 'User rejected the revised plan.',
        lastDecision: reply,
        updatedAt: new Date().toISOString(),
      });
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

    if (parsed.kind === 'restart') {
      if (!['stopped', 'planning_requested', 'ready_for_decision', 'waiting_user_direction'].includes(state.status)) {
        throw new Error(`Cannot restart planning from state ${state.status}.`);
      }
      state = restartFromPlanningState(state, parsed.instruction, reply);
      state = await this.store.appendArtifact(state, 'decision-log', `restart from planning:\n${parsed.instruction}`);
      await this.store.saveState(state);
      await this.refreshParentTaskReadme(state, 'User restarted planning with a new prompt.');
      return this.planTask(state.taskId);
    }

    if (parsed.kind === 'revise') {
      if (state.status === 'awaiting_user_acceptance') {
        state = {
          ...withoutPendingPrompt(state),
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
      const { blockerLedger: _blockerLedger, ...stateWithoutBlockerLedger } = state;
      state = {
        ...stateWithoutBlockerLedger,
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
      if (state.status === 'implementation_approved') {
        return this.implementApproved(state.taskId);
      }
      if (state.status === 'waiting_user_direction' && state.pendingUserDecision?.source === 'extra_high_planning') {
        return {
          state,
          message: state.pendingUserPrompt ?? 'Extra High reviewer concerns remain. Reply A to continue one round, B to restart planning, C to execute the current plan anyway, or say stop.',
        };
      }
      if (state.status !== 'ready_for_decision' && state.status !== 'waiting_user_direction') {
        throw new Error(`Cannot approve implementation from state ${state.status}.`);
      }
      state = appendWorkflowInstruction(state, parsed.instruction);
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

  async answerUserDirection(taskIdOrLatest: string, answer: string): Promise<WorkflowResult> {
    let state = await this.store.loadState(taskIdOrLatest);
    const trimmed = answer.trim();
    if (!trimmed) {
      throw new Error('Cannot answer user direction with an empty reply.');
    }
    if (state.status !== 'waiting_user_direction') {
      throw new Error(`Cannot answer user direction from state ${state.status}.`);
    }

    const pendingDecision = state.pendingUserDecision;
    const selectedOption = selectedDecisionOption(pendingDecision, trimmed);
    const decision = `user direction: ${trimmed}`;
    const directionLog = renderUserDirectionLog(trimmed, pendingDecision);
    const plannerDirection = renderUserDirectionForPlanner(trimmed, pendingDecision);
    if (pendingDecision?.source === 'plan_artifact_failure' || (!pendingDecision && isPlanArtifactFailurePrompt(state.pendingUserPrompt))) {
      if (/^(?:stop|b|停止)$/i.test(trimmed) || selectedOption?.id === 'B') {
        state = {
          ...withoutPendingPrompt(state),
          status: 'stopped',
          stoppedReason: 'User stopped planning after a heavy-agent plan artifact failure.',
          lastDecision: decision,
          updatedAt: new Date().toISOString(),
        };
        state = await this.store.appendArtifact(state, 'decision-log', directionLog);
        await this.store.saveState(state);
        return { state, message: 'Planning stopped after the plan artifact failure.' };
      }

      state = resetPlanningAfterUserDecision(state, `Retry planning after plan artifact failure:\n${plannerDirection}`, decision);
      state = await this.store.appendArtifact(state, 'decision-log', directionLog);
      await this.store.saveState(state);
      return this.planTask(state.taskId);
    }

    if (pendingDecision?.source === 'extra_high_planning') {
      if (/^stop$/i.test(trimmed)) {
        state = {
          ...withoutPendingPrompt(state),
          status: 'stopped',
          stoppedReason: 'User stopped Extra High planning while reviewer concerns remained.',
          lastDecision: decision,
          updatedAt: new Date().toISOString(),
        };
        state = await this.store.appendArtifact(state, 'decision-log', directionLog);
        await this.store.saveState(state);
        return { state, message: 'Extra High planning stopped.' };
      }

      if (isExtraHighExecuteCurrentPlanDirection(trimmed, selectedOption)) {
        state = {
          ...state,
          requestedChanges: [
            ...state.requestedChanges,
            'User explicitly chose to execute the current Extra High plan despite outstanding reviewer blockers.',
          ],
        };
        state = await this.persistApprovedTaskArtifacts(state);
        state = {
          ...withoutPendingPrompt(state),
          status: 'implementation_approved',
          approvedAt: new Date().toISOString(),
          lastDecision: decision,
          updatedAt: new Date().toISOString(),
        };
        state = await this.store.appendArtifact(
          state,
          'decision-log',
          `${directionLog}\nextra-high override: execute current plan despite outstanding reviewer blockers`,
        );
        await this.store.saveState(state);
        return this.implementApproved(state.taskId);
      }

      if (selectedOption?.id === 'B') {
        state = restartFromPlanningState(state, plannerDirection, decision);
        state = {
          ...state,
          difficulty: 'extra-high',
          extraHighRoundLimit: MAX_EXTRA_HIGH_PLANNING_ROUNDS,
          extraHighContinuationFromReview: false,
        };
        state = await this.store.appendArtifact(state, 'decision-log', directionLog);
        await this.store.saveState(state);
        return this.planTask(state.taskId);
      }

      if (!selectedOption && /^(?:approve|approved|approve\s+a|yes|y|同意|批准)$/i.test(trimmed)) {
        return {
          state,
          message: state.pendingUserPrompt ?? 'Extra High reviewer concerns remain. Reply A to continue one round, B to restart planning, C to execute the current plan anyway, or say stop.',
        };
      }

      const nextRoundLimit = Math.max(state.extraHighRoundLimit ?? MAX_EXTRA_HIGH_PLANNING_ROUNDS, state.reviewerRunCount) + 1;
      state = {
        ...withoutPendingPrompt(state),
        status: 'planning_requested',
        extraHighRoundLimit: nextRoundLimit,
        extraHighContinuationFromReview: true,
        requestedChanges: selectedOption?.id === 'A'
          ? state.requestedChanges
          : [...state.requestedChanges, `Extra High continuation direction:\n${plannerDirection}`],
        lastDecision: decision,
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', directionLog);
      await this.store.saveState(state);
      return this.planTask(state.taskId);
    }

    if (isFinalReviewFollowupCapDirection(state)) {
      if (isFinalReviewFollowupStopDirection(trimmed, selectedOption)) {
        state = clearFollowupScope({
          ...withoutPendingPrompt(state),
          status: 'stopped',
          stoppedReason: 'Repeated final-review failures; user chose to stop.',
          lastDecision: decision,
          updatedAt: new Date().toISOString(),
        });
        state = await this.store.appendArtifact(state, 'decision-log', directionLog);
        await this.store.saveState(state);
        return { state, message: 'Task stopped after repeated final-review follow-up failures.' };
      }

      if (selectedOption?.id === 'B') {
        state = resetPlanningAfterUserDecision(state, `Final review requested planning reconsideration:\n${plannerDirection}`, decision);
        state = clearFollowupScope(state);
        state = await this.store.appendArtifact(state, 'decision-log', `${directionLog}\nfinal-review follow-up sent back to planning`);
        await this.store.saveState(state);
        return this.planTask(state.taskId);
      }

      if (selectedOption?.id === 'C') {
        const deferredIssues = renderDeferredFinalReviewIssues(state, plannerDirection);
        state = clearFollowupScope({
          ...withoutPendingPrompt(state),
          status: 'awaiting_user_acceptance',
          lastDecision: decision,
          pendingUserPrompt: "Deferred issues recorded. Reply 'accept' to finalize the task record, or stop to pause.",
          updatedAt: new Date().toISOString(),
        });
        state = await this.store.writeArtifact(state, 'deferred-issues', deferredIssues);
        state = await this.store.appendArtifact(state, 'decision-log', `${directionLog}\nfinal-review follow-up deferred issues recorded`);
        await this.store.saveState(state);
        await this.refreshParentTaskReadme(state, 'Deferred final-review issues recorded; awaiting user acceptance.');
        return { state, message: state.pendingUserPrompt ?? 'Deferred issues recorded; awaiting user acceptance.' };
      }

      const reason = finalReviewFollowupReasonFromDecision(pendingDecision) ?? plannerDirection;
      const followup = makeFinalReviewFollowupScope(state, reason);
      state = {
        ...withoutPendingPrompt(state),
        status: 'implementation_approved',
        implementationFollowup: followup,
        requestedChanges: selectedOption?.id === 'A'
          ? state.requestedChanges
          : [...state.requestedChanges, `Final review follow-up continuation direction:\n${plannerDirection}`],
        lastDecision: decision,
        pendingUserPrompt: renderFinalReviewImplementationReroutePrompt(reason),
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', `${directionLog}\nfinal-review follow-up round ${followup.round} approved for retry`);
      await this.store.saveState(state);
      return { state, message: state.pendingUserPrompt ?? 'Final review follow-up is ready. Reply approve A to run it.' };
    }

    if (state.pendingUserDecision?.id === 'final-review-routing:fallback') {
      if (isFinalReviewFollowupStopDirection(trimmed, selectedOption)) {
        state = clearFollowupScope({
          ...withoutPendingPrompt(state),
          status: 'stopped',
          stoppedReason: 'Final-review routing needed user direction; user chose to stop.',
          lastDecision: decision,
          updatedAt: new Date().toISOString(),
        });
        state = await this.store.appendArtifact(state, 'decision-log', directionLog);
        await this.store.saveState(state);
        return { state, message: 'Task stopped after final-review routing decision.' };
      }

      if (selectedOption?.id === 'B') {
        state = resetPlanningAfterUserDecision(state, `Final review routing sent back to planning:\n${plannerDirection}`, decision);
        state = clearFollowupScope(state);
        state = await this.store.appendArtifact(state, 'decision-log', `${directionLog}\nfinal-review routing sent back to planning`);
        await this.store.saveState(state);
        return this.planTask(state.taskId);
      }

      if (selectedOption?.id === 'C') {
        const deferredIssues = renderDeferredFinalReviewIssues(state, plannerDirection);
        state = clearFollowupScope({
          ...withoutPendingPrompt(state),
          status: 'awaiting_user_acceptance',
          lastDecision: decision,
          pendingUserPrompt: "Deferred issues recorded. Reply 'accept' to finalize the task record, or stop to pause.",
          updatedAt: new Date().toISOString(),
        });
        state = await this.store.writeArtifact(state, 'deferred-issues', deferredIssues);
        state = await this.store.appendArtifact(state, 'decision-log', `${directionLog}\nfinal-review routing deferred issues recorded`);
        await this.store.saveState(state);
        await this.refreshParentTaskReadme(state, 'Deferred final-review issues recorded; awaiting user acceptance.');
        return { state, message: state.pendingUserPrompt ?? 'Deferred issues recorded; awaiting user acceptance.' };
      }

      const reason = finalReviewFollowupReasonFromDecision(pendingDecision) ?? plannerDirection;
      const followup = makeFinalReviewFollowupScope(state, reason);
      state = {
        ...withoutPendingPrompt(state),
        status: 'implementation_approved',
        implementationFollowup: followup,
        requestedChanges: selectedOption?.id === 'A'
          ? state.requestedChanges
          : [...state.requestedChanges, `Final review routing continuation direction:\n${plannerDirection}`],
        lastDecision: decision,
        pendingUserPrompt: renderFinalReviewImplementationReroutePrompt(reason),
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', `${directionLog}\nfinal-review routing approved implementation follow-up`);
      await this.store.saveState(state);
      return { state, message: state.pendingUserPrompt ?? 'Final review follow-up is ready. Reply approve A to run it.' };
    }

    if (isFinalReviewUserDirection(state)) {
      if (isAcceptCurrentWorktreeDirection(trimmed, selectedOption)) {
        state = {
          ...withoutPendingPrompt(state),
          status: 'awaiting_user_acceptance',
          lastDecision: decision,
          updatedAt: new Date().toISOString(),
        };
        state = await this.store.appendArtifact(state, 'decision-log', directionLog);
        await this.store.saveState(state);
        await this.refreshParentTaskReadme(state, 'User direction accepted final review scope; awaiting user acceptance.');
        return { state, message: "已记录你的选择：接受当前工作区现状。现在进入验收阶段；直接说 '验收通过' / 'accept' 即可生成 task-record。" };
      }

      const continuePrompt = '已记录你的方向。如果要系统按这个方向继续处理，请回复 approve A、yes 或「继续修复」；也可以回复 stop 暂停。';
      const followup = makeFinalReviewFollowupScope(state, plannerDirection);
      state = {
        ...withoutPendingPrompt(state),
        status: 'implementation_approved',
        implementationFollowup: followup,
        requestedChanges: [...state.requestedChanges, `User direction after final review:\n${plannerDirection}`],
        lastDecision: decision,
        pendingUserPrompt: continuePrompt,
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', directionLog);
      await this.store.saveState(state);
      return { state, message: continuePrompt };
    }

    state = resetPlanningAfterUserDecision(state, `User direction:\n${plannerDirection}`, decision);
    state = await this.store.appendArtifact(state, 'decision-log', directionLog);
    await this.store.saveState(state);
    return this.planTask(state.taskId);
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
    const followup = state.implementationFollowup;
    const priorImplementationLog = followup ? await this.store.readArtifact(state, 'implementation-log').catch(() => '') : undefined;
    const priorVerificationLog = followup ? await this.store.readArtifact(state, 'test-build-log').catch(() => '') : undefined;
    const projectContext = await this.buildProjectContext(state, [
      task,
      revisedPlan,
      followup ? `Final review follow-up reason:\n${followup.reason}` : undefined,
      priorImplementationLog ? `Prior implementation log:\n${priorImplementationLog}` : undefined,
      priorVerificationLog ? `Prior verification log:\n${priorVerificationLog}` : undefined,
    ].filter(Boolean).join('\n\n'));
    const preGit = await readGitSnapshot(scopedConfig.workspace.targetDir);

    if (followup) {
      state = await this.store.writeArtifact(state, 'followup-git-pre-status', preGit.statusShort ? `${preGit.statusShort}\n` : '');
      state = await this.store.writeArtifact(state, 'followup-git-pre-diff', preGit.diff);
    } else {
      state = await this.store.writeArtifact(state, 'git-pre-status', preGit.statusShort ? `${preGit.statusShort}\n` : '');
      state = await this.store.writeArtifact(state, 'git-pre-diff', preGit.diff);
    }
    state = { ...state, status: 'implementing', currentExecutionIndex: 0, updatedAt: new Date().toISOString() };
    await this.store.saveState(state);

    const verificationRuns: Array<{ unit: ExecutionUnitState; results: VerificationCommandResult[] }> = [];
    if (followup) {
      const activeUnit = makeFinalReviewFollowupExecutionUnit(followup.round);
      const stateWithoutCurrentExecution = { ...state };
      delete stateWithoutCurrentExecution.currentExecutionIndex;
      state = { ...stateWithoutCurrentExecution, status: 'execution_unit_implementing', updatedAt: new Date().toISOString() };
      await this.store.saveState(state);
      await this.refreshParentTaskReadme(state, activeUnit.name);

      const implementation = await this.heavyAgents.implement({
        task,
        projectContext,
        revisedPlan,
        executionUnit: activeUnit,
        state,
        config: scopedConfig,
        mode: 'final_review_followup',
        finalReviewReason: followup.reason,
        ...(priorImplementationLog !== undefined ? { priorImplementationLog } : {}),
        ...(priorVerificationLog !== undefined ? { priorVerificationLog } : {}),
      });
      state = await this.appendAgentPrompt(state, implementation.agentPrompt);
      const implementationSection = [
        `## Final Review Follow-up (round ${followup.round})`,
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
        `# Final Review Follow-up (round ${followup.round})`,
        '',
        renderVerificationLog(verification),
      ].join('\n'));

      state = { ...state, status: 'execution_unit_result_recording', updatedAt: new Date().toISOString() };
      await this.store.saveState(state);
      state = { ...state, status: 'next_execution_unit_or_all_done', updatedAt: new Date().toISOString() };
      await this.store.saveState(state);
      await this.refreshParentTaskReadme(state, `${activeUnit.name} completed.`);
    } else {
      const executionQueue = state.executionQueue.length > 0 ? state.executionQueue : makeExecutionUnits(undefined);
      state = { ...state, executionQueue, executionMode: executionModeFor(executionQueue), updatedAt: new Date().toISOString() };
      await this.store.saveState(state);

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
          mode: 'full_plan',
        });
        state = await this.appendAgentPrompt(state, implementation.agentPrompt);
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
    }

    const postGit = await readGitSnapshot(scopedConfig.workspace.targetDir);
    if (followup) {
      state = await this.store.writeArtifact(state, 'followup-git-post-status', postGit.statusShort ? `${postGit.statusShort}\n` : '');
      state = await this.store.writeArtifact(state, 'followup-git-post-diff', postGit.diff);
    }
    state = await this.store.writeArtifact(state, 'git-post-status', postGit.statusShort ? `${postGit.statusShort}\n` : '');
    state = await this.store.writeArtifact(state, 'git-post-diff', postGit.diff);
    const stateWithoutCurrentExecution = { ...state };
    delete stateWithoutCurrentExecution.currentExecutionIndex;
    state = clearFollowupScope({
      ...stateWithoutCurrentExecution,
      ...(followup ? {
        implementationFollowupHistory: [
          ...(state.implementationFollowupHistory ?? []),
          {
            round: followup.round,
            reason: followup.reason,
            completedAt: new Date().toISOString(),
          },
        ],
      } : {}),
      status: 'implemented',
      updatedAt: new Date().toISOString(),
    });
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
    state = await this.appendAgentPrompt(state, finalReview.agentPrompt);
    state = await this.store.writeArtifact(state, 'final-review', finalReview.markdown);
    await this.taskRecords.writeFinalReview(this.projectForState(state), state, finalReview.markdown);

    const assistantRoute = await this.assistant.routeAfterFinalReview({
      finalReview: finalReview.markdown,
      verificationLog,
      state,
      config: this.configForState(state),
    });
    const routeNormalization = normalizeFinalReviewRoute(assistantRoute, finalReview.markdown, verificationLog);
    const route = routeNormalization.route;
    state = { ...state, status: 'final_review_routing', lastDecision: route.route, updatedAt: new Date().toISOString() };
    if (routeNormalization.decisionLogNote) {
      state = await this.store.appendArtifact(state, 'decision-log', routeNormalization.decisionLogNote);
    }
    await this.store.saveState(state);

    if (route.route === 'complete') {
      state = {
        ...state,
        status: 'awaiting_user_acceptance',
        pendingUserPrompt: "等你验收：直接说 '验收通过' / 'accept' 即可生成 task-record。",
        updatedAt: new Date().toISOString(),
      };
      state = clearFollowupScope(state);
      await this.store.saveState(state);
      await this.refreshParentTaskReadme(state, `Final review route: complete. ${route.reason}`);
      return { state, message: 'Final review passed. Awaiting user acceptance before task recording and completion.' };
    }

    if (route.route === 'route_to_implementer') {
      if ((state.implementationFollowupHistory?.length ?? 0) >= MAX_AUTOMATIC_FINAL_REVIEW_FOLLOWUP_ROUNDS) {
        state = await this.pauseForAgentDecision(state, 'final_review', makeFinalReviewFollowupCapDecision(state, route.reason));
        return { state, message: state.pendingUserPrompt ?? 'Final review still has implementation blockers after follow-up.' };
      }
      const reroutePrompt = renderFinalReviewImplementationReroutePrompt(route.reason);
      state = {
        ...state,
        status: 'implementation_approved',
        requestedChanges: [...state.requestedChanges, renderFinalReviewImplementationChange(route.reason)],
        implementationFollowup: makeFinalReviewFollowupScope(state, route.reason),
        pendingUserPrompt: reroutePrompt,
        updatedAt: new Date().toISOString(),
      };
      state = await this.store.appendArtifact(state, 'decision-log', `final review routed to implementation:\n${route.reason}`);
      await this.store.saveState(state);
      return { state, message: reroutePrompt };
    }

    if (route.route === 'route_to_planner') {
      const planningChange = renderFinalReviewPlanningChange(route.reason);
      state = {
        ...state,
        status: 'planning_requested',
        requestedChanges: [...state.requestedChanges, planningChange],
        updatedAt: new Date().toISOString(),
      };
      state = clearFollowupScope(state);
      state = await this.store.appendArtifact(state, 'decision-log', `final review routed to planning:\n${route.reason}`);
      await this.store.saveState(state);
      return this.planTask(state.taskId);
    }

    if (route.userDecision) {
      state = await this.pauseForAssistantDecision(
        state,
        {
          markdown: renderFinalReviewUserDirectionPrompt(route.reason, route.userPrompt),
          ...(route.userPrompt ? { userPrompt: route.userPrompt } : {}),
          userDecision: route.userDecision,
        },
        'final_review',
      );
      return { state, message: state.pendingUserPrompt ?? 'Final review needs a user direction decision.' };
    }

    state = await this.pauseForAgentDecision(state, 'final_review', makeFinalReviewRoutingFallbackDecision(route.reason, route.userPrompt));
    state = await this.store.appendArtifact(state, 'decision-log', 'final review routing requested user direction without structured options; VibeCodingAssistant-ElonMa generated fallback options');
    await this.store.saveState(state);
    return { state, message: state.pendingUserPrompt ?? 'Final review needs a user direction decision.' };
  }

  async showArtifact(taskIdOrLatest: string, artifact: ArtifactName): Promise<string> {
    const state = await this.store.loadState(taskIdOrLatest);
    if (artifact === 'agent-prompt-preview') {
      const next = await this.writeAgentPromptPreview(state);
      await this.store.saveState(next.state);
      return next.content;
    }
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

  private async runExtraHighPlanningLoop(
    state: TaskState,
    task: string,
    projectContext: string,
    scopedConfig: AssistantConfig,
  ): Promise<ExtraHighLoopResult> {
    const roundLimit = Math.max(state.extraHighRoundLimit ?? MAX_EXTRA_HIGH_PLANNING_ROUNDS, MAX_EXTRA_HIGH_PLANNING_ROUNDS);
    const resumeFromReview = state.extraHighContinuationFromReview === true
      && state.artifacts['revised-plan']
      && state.artifacts.review
      && state.reviewerRunCount > 0;
    let currentPlan: PlanResult;
    let currentReview = '';
    let startRound = 1;

    if (resumeFromReview) {
      const latestPlan = await this.store.readArtifact(state, 'revised-plan');
      const metadata = readPlanMetadata(latestPlan);
      currentPlan = {
        markdown: stripExtraHighCapNote(stripPlanMetadata(latestPlan)),
        verificationCommands: metadata.verificationCommands,
        ...(metadata.planPackDraft ? { planPackDraft: metadata.planPackDraft } : {}),
      };
      currentReview = await this.store.readArtifact(state, 'review');
      state = { ...state, extraHighContinuationFromReview: false };
      startRound = state.reviewerRunCount + 1;
    } else {
      const initialPlanResult = await this.runPlanAgent(state, 'extra-high initial plan', () => this.heavyAgents.createInitialPlan({
        task,
        projectContext,
        difficulty: 'extra-high',
        state,
        config: scopedConfig,
      }));
      if (!initialPlanResult.ok) return { state: initialPlanResult.state, paused: true, message: initialPlanResult.message };
      currentPlan = initialPlanResult.plan;
      state = await this.appendAgentPrompt(state, currentPlan.agentPrompt);
      if (currentPlan.decisionParseError) {
        state = await this.pauseForInvalidAgentDecision(state, 'architect_plan', currentPlan.decisionParseError, currentPlan.markdown);
        return { state, paused: true, message: state.pendingUserPrompt ?? 'Architect output needs a valid structured user decision block.' };
      }
      state = await this.store.writeArtifact(state, 'initial-plan', currentPlan.markdown);
      if (currentPlan.userDecision) {
        state = await this.pauseForAgentDecision(state, 'architect_plan', currentPlan.userDecision);
        return { state, paused: true, message: state.pendingUserPrompt ?? 'Architect needs a user decision before planning can continue.' };
      }
    }

    for (let round = startRound; round <= roundLimit; round += 1) {
      if (round > 1) {
        const revisedPlanResult = await this.runPlanAgent(state, `extra-high revised plan round ${round}`, () => this.heavyAgents.revisePlan({
          task,
          projectContext,
          initialPlan: currentPlan.markdown,
          review: currentReview,
          requestedChanges: state.requestedChanges,
          difficulty: 'extra-high',
          state,
          config: scopedConfig,
          ...(state.blockerLedger ? { blockerLedgerText: renderLedgerForArchitectPrompt(state.blockerLedger) } : {}),
        }));
        if (!revisedPlanResult.ok) return { state: revisedPlanResult.state, paused: true, message: revisedPlanResult.message };
        currentPlan = revisedPlanResult.plan;
        state = await this.appendAgentPrompt(state, currentPlan.agentPrompt);
        if (currentPlan.decisionParseError) {
          state = await this.pauseForInvalidAgentDecision(state, 'architect_plan', currentPlan.decisionParseError, currentPlan.markdown);
          return { state, paused: true, message: state.pendingUserPrompt ?? 'Architect output needs a valid structured user decision block.' };
        }
        const architectLedger = await this.applyArchitectLedgerOrPause(state, currentPlan, 'extra-high', round);
        if (architectLedger.paused) return { state: architectLedger.state, paused: true, message: architectLedger.message };
        state = architectLedger.state;
        state = await this.store.writeArtifact(state, 'initial-plan', currentPlan.markdown);
        if (hasArchitectNeedsUserDecision(currentPlan) && !currentPlan.userDecision) {
          state = await this.pauseForInvalidBlockerOutput(state, 'Architect', 'architect response status needs_user_decision requires an assistant-user-decision block');
          return { state, paused: true, message: state.pendingUserPrompt ?? 'Architect blocker response needs a structured user decision block.' };
        }
        if (currentPlan.userDecision) {
          state = await this.pauseForAgentDecision(state, 'architect_plan', currentPlan.userDecision);
          return { state, paused: true, message: state.pendingUserPrompt ?? 'Architect needs a user decision before planning can continue.' };
        }
      }

      const review = await this.heavyAgents.reviewPlan({
        task,
        projectContext,
        initialPlan: currentPlan.markdown,
        difficulty: 'extra-high',
        state,
        config: scopedConfig,
        ...(state.blockerLedger ? { blockerLedgerText: renderLedgerForReviewerPrompt(state.blockerLedger) } : {}),
      });
      currentReview = review.markdown;
      state = await this.appendAgentPrompt(state, review.agentPrompt);
      const reviewRound = state.reviewerRunCount + 1;
      state = {
        ...await this.store.writeArtifact(state, 'review', currentReview),
        reviewerRunCount: reviewRound,
      };
      if (review.decisionParseError) {
        state = await this.pauseForInvalidAgentDecision(state, 'plan_review', review.decisionParseError, review.markdown);
        return { state, paused: true, message: state.pendingUserPrompt ?? 'Plan Reviewer output needs a valid structured user decision block.' };
      }
      const reviewerLedger = await this.applyReviewerLedgerOrPause(state, review, 'extra-high', reviewRound);
      if (reviewerLedger.paused) return { state: reviewerLedger.state, paused: true, message: reviewerLedger.message };
      state = reviewerLedger.state;
      if (review.userDecision) {
        state = await this.pauseForAgentDecision(state, 'plan_review', review.userDecision);
        return { state, paused: true, message: state.pendingUserPrompt ?? 'Plan Reviewer needs a user decision before revise can continue.' };
      }

      const ledger = state.blockerLedger;
      if (ledger && activeBlockers(ledger).length === 0) {
        const finalNextRoundDirective = EXTRA_HIGH_APPROVED_NEXT_ROUND_DIRECTIVE;
        state = await this.appendPlanRoundLog(state, {
          round,
          planMarkdown: currentPlan.markdown,
          reviewMarkdown: currentReview,
          verdict: 'approved',
          nextRoundDirective: finalNextRoundDirective,
          ledgerSnapshot: renderRoundLedgerSnapshot(ledger, round),
          ...(currentPlan.sourcePath ? { planSourcePath: currentPlan.sourcePath } : {}),
          ...(currentPlan.stdoutSummary ? { plannerStdoutSummary: currentPlan.stdoutSummary } : {}),
        });
        state = await this.store.writeArtifact(state, 'revised-plan', currentPlan.markdown);
        return {
          state,
          finalPlan: currentPlan,
          finalReview: currentReview,
          finalNextRoundDirective,
          rounds: round,
          capHitWithIssues: false,
        };
      }

      if (round === roundLimit) {
        const finalNextRoundDirective = EXTRA_HIGH_CAP_NEXT_ROUND_DIRECTIVE;
        state = await this.appendPlanRoundLog(state, {
          round,
          planMarkdown: currentPlan.markdown,
          reviewMarkdown: currentReview,
          verdict: 'issues_remain',
          nextRoundDirective: finalNextRoundDirective,
          ...(state.blockerLedger ? { ledgerSnapshot: renderRoundLedgerSnapshot(state.blockerLedger, round) } : {}),
          ...(currentPlan.sourcePath ? { planSourcePath: currentPlan.sourcePath } : {}),
          ...(currentPlan.stdoutSummary ? { plannerStdoutSummary: currentPlan.stdoutSummary } : {}),
        });
        state = await this.store.appendArtifact(state, 'plan-rounds-log', [
          '## Outstanding Blocker Ledger',
          '',
          state.blockerLedger ? renderUnclosedBlockerSummary(state.blockerLedger) : currentReview,
        ].join('\n'));
        state = await this.store.appendArtifact(
          state,
          'decision-log',
          `extra-high planning paused after round ${round}; active blocker ledger recorded in plan-rounds-log.md`,
        );
        const finalPlan = {
          ...currentPlan,
          markdown: [renderExtraHighCapNote(round, state.blockerLedger), '', currentPlan.markdown].join('\n'),
        };
        state = await this.store.writeArtifact(state, 'revised-plan', finalPlan.markdown);
        state = await this.pauseForUserDirection(state, makeExtraHighContinuationDecision(round, state.blockerLedger));
        return {
          state,
          paused: true,
          message: state.pendingUserPrompt ?? `Extra High planning still has reviewer concerns after round ${round}.`,
        };
      }

      state = await this.appendPlanRoundLog(state, {
        round,
        planMarkdown: currentPlan.markdown,
        reviewMarkdown: currentReview,
        verdict: 'revision_requested',
        nextRoundDirective: REVIEWER_AUTHORITATIVE_NEXT_ROUND_DIRECTIVE,
        ...(state.blockerLedger ? { ledgerSnapshot: renderRoundLedgerSnapshot(state.blockerLedger, round) } : {}),
        ...(currentPlan.sourcePath ? { planSourcePath: currentPlan.sourcePath } : {}),
        ...(currentPlan.stdoutSummary ? { plannerStdoutSummary: currentPlan.stdoutSummary } : {}),
      });
    }

    throw new Error('extra-high planning loop exited without a final plan.');
  }

  private async appendPlanRoundLog(
    state: TaskState,
    input: {
      round: number;
      planMarkdown: string;
      reviewMarkdown: string;
      verdict: PlanRoundVerdict;
      nextRoundDirective: string;
      planSourcePath?: string;
      plannerStdoutSummary?: string;
      ledgerSnapshot?: string;
    },
  ): Promise<TaskState> {
    return this.store.appendArtifact(state, 'plan-rounds-log', renderPlanRoundLogEntry(input));
  }

  private async applyReviewerLedgerOrPause(
    state: TaskState,
    review: ReviewResult,
    difficulty: WorkflowDifficulty,
    round: number,
  ): Promise<{ paused: false; state: TaskState } | { paused: true; state: TaskState; message: string }> {
    if (!usesBlockerLedger(difficulty)) return { paused: false, state };
    if (review.blockerLedgerParseError) {
      const next = await this.pauseForInvalidBlockerOutput(state, 'Plan Reviewer', review.blockerLedgerParseError);
      return { paused: true, state: next, message: next.pendingUserPrompt ?? 'Plan Reviewer blocker ledger output is invalid.' };
    }
    if (!review.reviewerBlockerOutput) {
      const next = await this.pauseForInvalidBlockerOutput(state, 'Plan Reviewer', 'missing reviewer-blockers block');
      return { paused: true, state: next, message: next.pendingUserPrompt ?? 'Plan Reviewer must output a reviewer-blockers block.' };
    }
    const validation = validateReviewerOutputAgainstLedger(review.reviewerBlockerOutput, state.blockerLedger, round);
    if (!validation.ok) {
      const next = await this.pauseForInvalidBlockerOutput(state, 'Plan Reviewer', validation.error);
      return { paused: true, state: next, message: next.pendingUserPrompt ?? 'Plan Reviewer blocker ledger output is invalid.' };
    }
    const blockerLedger = applyReviewerOutput(state.blockerLedger, review.reviewerBlockerOutput, round);
    let next: TaskState = { ...state, blockerLedger, updatedAt: new Date().toISOString() };
    next = await this.store.writeArtifact(next, 'blocker-ledger', renderBlockerLedgerArtifact(blockerLedger));
    return { paused: false, state: next };
  }

  private async applyArchitectLedgerOrPause(
    state: TaskState,
    plan: PlanResult,
    difficulty: WorkflowDifficulty,
    round: number,
  ): Promise<{ paused: false; state: TaskState } | { paused: true; state: TaskState; message: string }> {
    if (!usesBlockerLedger(difficulty)) return { paused: false, state };
    if (plan.blockerResponseParseError) {
      const next = await this.pauseForInvalidBlockerOutput(state, 'Architect', plan.blockerResponseParseError);
      return { paused: true, state: next, message: next.pendingUserPrompt ?? 'Architect blocker response output is invalid.' };
    }
    const ledger = state.blockerLedger;
    if (!ledger || activeBlockers(ledger).length === 0) return { paused: false, state };
    if (!plan.architectBlockerResponses) {
      const next = await this.pauseForInvalidBlockerOutput(state, 'Architect', 'missing architect-blocker-responses block');
      return { paused: true, state: next, message: next.pendingUserPrompt ?? 'Architect must output an architect-blocker-responses block.' };
    }
    const validation = validateArchitectResponsesAgainstLedger(plan.architectBlockerResponses, ledger);
    if (!validation.ok) {
      const next = await this.pauseForInvalidBlockerOutput(state, 'Architect', validation.error);
      return { paused: true, state: next, message: next.pendingUserPrompt ?? 'Architect blocker response output is invalid.' };
    }
    const blockerLedger = applyArchitectResponses(ledger, plan.architectBlockerResponses, round);
    let next: TaskState = { ...state, blockerLedger, updatedAt: new Date().toISOString() };
    next = await this.store.writeArtifact(next, 'blocker-ledger', renderBlockerLedgerArtifact(blockerLedger));
    return { paused: false, state: next };
  }

  private async runPlanAgent(
    state: TaskState,
    phase: string,
    run: () => Promise<PlanResult>,
  ): Promise<{ ok: true; plan: PlanResult } | { ok: false; state: TaskState; message: string }> {
    try {
      const plan = await run();
      if (!plan.userDecision && isDegeneratePlanBody(plan.markdown)) {
        const paused = await this.pauseForPlanArtifactFailure(state, {
          phase,
          plan,
          reason: 'agent returned an empty plan or only a plan-path status line',
        });
        return { ok: false, state: paused, message: paused.pendingUserPrompt ?? 'Heavy agent did not provide a usable plan artifact.' };
      }
      return { ok: true, plan };
    } catch (error) {
      if (error instanceof HeavyAgentArtifactError) {
        const paused = await this.pauseForPlanArtifactFailure(state, {
          phase,
          error,
          reason: error.message,
        });
        return { ok: false, state: paused, message: paused.pendingUserPrompt ?? 'Heavy agent did not provide a readable plan artifact.' };
      }
      throw error;
    }
  }

  private async pauseForPlanArtifactFailure(
    state: TaskState,
    input: {
      phase: string;
      reason: string;
      plan?: Pick<PlanResult, 'markdown' | 'sourcePath' | 'stdoutSummary'>;
      error?: HeavyAgentArtifactError;
    },
  ): Promise<TaskState> {
    let next = await this.store.appendArtifact(state, 'plan-rounds-log', renderPlanArtifactFailureLog(input));
    next = await this.store.appendArtifact(next, 'decision-log', [
      `plan artifact failure during ${input.phase}`,
      `reason: ${input.reason}`,
      `source: ${input.plan?.sourcePath ?? input.error?.sourcePath ?? 'stdout'}`,
    ].join('\n'));
    const prompt = renderPlanArtifactFailurePrompt(input);
    const pendingUserDecision = makePlanArtifactFailureDecision(input);
    next = {
      ...withoutPendingPrompt(next),
      status: 'waiting_user_direction',
      pendingUserPrompt: prompt,
      pendingUserDecision,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveState(next);
    return next;
  }

  private async pauseForInvalidAgentDecision(
    state: TaskState,
    source: PendingUserDecisionSource,
    error: string,
    fallbackMarkdown: string,
  ): Promise<TaskState> {
    const prompt = renderInvalidUserDecisionPause({
      source,
      error,
      fallbackText: fallbackMarkdown,
    });
    let next: TaskState = {
      ...withoutPendingPrompt(state),
      status: 'waiting_user_direction' as const,
      pendingUserPrompt: prompt,
      updatedAt: new Date().toISOString(),
    };
    next = await this.store.appendArtifact(next, 'decision-log', `invalid user decision output (${source}): ${error}`);
    await this.store.saveState(next);
    return next;
  }

  private async pauseForInvalidBlockerOutput(
    state: TaskState,
    actor: 'Architect' | 'Plan Reviewer',
    error: string,
  ): Promise<TaskState> {
    const prompt = [
      `${actor} blocker ledger output is invalid.`,
      `Validation failure: ${error}`,
      '',
      'Workflow paused before continuing planning. Ask the agent to output the required structured blocker ledger block, or restart planning.',
    ].join('\n');
    let next: TaskState = {
      ...withoutPendingPrompt(state),
      status: 'waiting_user_direction',
      pendingUserPrompt: prompt,
      updatedAt: new Date().toISOString(),
    };
    next = await this.store.appendArtifact(next, 'decision-log', `invalid blocker ledger output (${actor}): ${error}`);
    await this.store.saveState(next);
    return next;
  }

  private async pauseForAgentDecision(
    state: TaskState,
    source: PendingUserDecisionSource,
    decision: PendingUserDecision,
  ): Promise<TaskState> {
    const next = await this.store.appendArtifact(state, 'decision-log', renderAgentDecisionRequestLog(source, decision));
    return this.pauseForUserDirection(next, decision);
  }

  private async pauseForAssistantDecision(
    state: TaskState,
    result: { markdown: string; userPrompt?: string; userDecision?: PendingUserDecision },
    source: PendingUserDecisionSource,
  ): Promise<TaskState> {
    const decision = normalizePendingUserDecision(result.userDecision, source);
    if (!decision.ok) {
      const prompt = renderInvalidUserDecisionPause({
        source,
        error: decision.error,
        fallbackText: result.markdown,
      });
      let next: TaskState = {
        ...withoutPendingPrompt(state),
        status: 'waiting_user_direction' as const,
        pendingUserPrompt: prompt,
        updatedAt: new Date().toISOString(),
      };
      next = await this.store.appendArtifact(next, 'decision-log', `invalid user decision output (${source}): ${decision.error}`);
      await this.store.saveState(next);
      return next;
    }
    return this.pauseForUserDirection(state, decision.decision);
  }

  private async pauseForUserDirection(state: TaskState, decision: PendingUserDecision): Promise<TaskState> {
    const next = {
      ...withoutPendingPrompt(state),
      status: 'waiting_user_direction' as const,
      pendingUserDecision: decision,
      pendingUserPrompt: renderPendingUserDecision(decision),
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveState(next);
    return next;
  }

  private async writePlanMetadata(state: TaskState, plan: PlanResult): Promise<TaskState> {
    return this.store.appendArtifact(state, 'revised-plan', [
      '',
      '<!-- assistant-plan-metadata',
      JSON.stringify({
        verificationCommands: plan.verificationCommands,
        planPackDraft: plan.planPackDraft,
      }, null, 2),
      'assistant-plan-metadata -->',
    ].join('\n'));
  }

  private async appendAgentPrompt(state: TaskState, promptRecord?: AgentPromptRecord): Promise<TaskState> {
    if (!promptRecord) return state;
    return this.store.appendArtifact(state, 'agent-prompts', renderAgentPromptRecord(promptRecord));
  }

  private async writeAgentPromptPreview(state: TaskState): Promise<{ state: TaskState; content: string }> {
    const task = await this.store.readArtifact(state, 'original-task');
    const projectContext = await this.buildProjectContext(state, [task, state.requestedChanges.join('\n')].filter(Boolean).join('\n\n'));
    const difficulties: WorkflowDifficulty[] = state.difficulty ? [state.difficulty] : WORKFLOW_DIFFICULTIES;
    const sections = difficulties.flatMap((difficulty) => [
      `## Architect Prompt - ${difficulty}`,
      '',
      buildInitialPlanPrompt({
        task,
        projectContext,
        difficulty,
        state,
      }),
      '',
    ]);
    const content = [
      '# Agent Prompt Preview',
      '',
      state.difficulty
        ? `Current difficulty: ${state.difficulty}. This uses the same prompt builder as the real Architect call.`
        : 'Difficulty has not been selected yet. The exact Architect call depends on the chosen difficulty, so this preview shows all currently possible Architect prompts.',
      '',
      '## Planning Input Decision',
      '',
      'Planning input mode: authoritative original prompt',
      'Reason: Assistant prompt rewriting is disabled. The Architect prompt always uses the original user prompt as the source of truth.',
      '',
      ...sections,
    ].join('\n');
    const next = await this.store.writeArtifact(state, 'agent-prompt-preview', content);
    return { state: next, content };
  }

  private async requireArtifact(state: TaskState, artifact: ArtifactName, message: string): Promise<string> {
    if (!state.artifacts[artifact]) throw new Error(message);
    return this.store.readArtifact(state, artifact);
  }

  private projectForState(state: TaskState) {
    return requireProject(this.config, state.projectId ?? getDefaultProjectId(this.config));
  }

  private configForState(state: TaskState): AssistantConfig {
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
      'initial-plan',
      'review',
      'revision-instructions',
      'plan-rounds-log',
      'blocker-ledger',
      'revised-plan',
      'assistant-explanation',
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
    if (state.artifacts['assistant-explanation']) {
      lines.push('', '## Latest Assistant Explanation', await this.store.readArtifact(state, 'assistant-explanation'));
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
    const deferredIssues = await this.store.readArtifact(state, 'deferred-issues').catch(() => '');
    const newStatusLines = diffStatusLines(before, after);

    return [
      '# Final Report',
      '',
      `Task: ${state.title}`,
      `Task ID: ${state.taskId}`,
      `Assistant final route: complete`,
      `Assistant reason: ${managerReason}`,
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
      deferredIssues ? '## Deferred Issues' : undefined,
      deferredIssues ? '' : undefined,
      deferredIssues || undefined,
      deferredIssues ? '' : undefined,
    ].join('\n');
  }
}

function renderAgentPromptRecord(record: AgentPromptRecord): string {
  const fence = markdownFence(record.prompt);
  return [
    `## ${record.createdAt} - ${record.role}`,
    '',
    `- Task ID: ${record.taskId}`,
    `- Role: ${record.role}`,
    `- Difficulty: ${record.difficulty}`,
    `- Profile: ${record.profileName}`,
    `- Profile kind: ${record.profileKind}`,
    ...(record.model ? [`- Model: ${record.model}`] : []),
    ...(record.effort ? [`- Effort: ${record.effort}`] : []),
    '',
    'Prompt sent via stdin:',
    '',
    `${fence}text`,
    record.prompt,
    fence,
  ].join('\n');
}

function markdownFence(content: string): string {
  const runs = content.match(/`{3,}/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return '`'.repeat(longest + 1);
}

function renderPlanRoundLogEntry(input: {
  round: number;
  planMarkdown: string;
  reviewMarkdown: string;
  verdict: PlanRoundVerdict;
  nextRoundDirective: string;
  planSourcePath?: string;
  plannerStdoutSummary?: string;
  ledgerSnapshot?: string;
}): string {
  const nextRoundDirective = input.nextRoundDirective.trim() || 'n/a';
  const stdoutSummary = input.plannerStdoutSummary?.trim() || '(none)';
  return [
    `## Round ${input.round}`,
    '',
    `verdict: ${input.verdict}`,
    `Planner Output Source: ${input.planSourcePath ?? 'stdout'}`,
    `Planner Stdout Summary: ${stdoutSummary}`,
    `next-round-directive: ${nextRoundDirective}`,
    '',
    '### Planner Output',
    '',
    input.planMarkdown,
    '',
    '### Reviewer Output',
    '',
    input.reviewMarkdown,
    '',
    input.ledgerSnapshot ? '### Blocker Ledger Snapshot' : undefined,
    input.ledgerSnapshot ? '' : undefined,
    input.ledgerSnapshot,
    input.ledgerSnapshot ? '' : undefined,
    '### Next Round Directive',
    '',
    nextRoundDirective,
  ].filter((line): line is string => line !== undefined).join('\n');
}

function renderPlanArtifactFailureLog(input: {
  phase: string;
  reason: string;
  plan?: Pick<PlanResult, 'markdown' | 'sourcePath' | 'stdoutSummary'>;
  error?: HeavyAgentArtifactError;
}): string {
  const source = input.plan?.sourcePath ?? input.error?.sourcePath ?? 'stdout';
  return [
    '## Plan Artifact Failure',
    '',
    `phase: ${input.phase}`,
    `reason: ${input.reason}`,
    `Planner Output Source: invalid (degenerate body, source=${source})`,
    `Planner Stdout Summary: ${input.plan?.stdoutSummary?.trim() || '(none)'}`,
    '',
    '### Planner Output',
    '',
    input.plan?.markdown?.trim() || '(none)',
  ].join('\n');
}

function renderPlanArtifactFailurePrompt(input: {
  phase: string;
  reason: string;
  plan?: Pick<PlanResult, 'markdown' | 'sourcePath' | 'stdoutSummary'>;
  error?: HeavyAgentArtifactError;
}): string {
  const source = input.plan?.sourcePath ?? input.error?.sourcePath ?? 'stdout';
  return [
    'Heavy agent did not provide a usable plan artifact. VibeCodingAssistant-ElonMa paused the workflow instead of sending an empty plan to Reviewer/Planner.',
    `Phase: ${input.phase}`,
    `Source: ${source}`,
    `Reason: ${input.reason}`,
    '',
    'The task has not advanced to review or implementation. Re-run planning after fixing the agent output/artifact issue.',
  ].join('\n');
}

function isPlanArtifactFailurePrompt(prompt: string | undefined): boolean {
  return Boolean(prompt?.includes('Heavy agent did not provide a usable plan artifact'));
}

function makePlanArtifactFailureDecision(input: {
  phase: string;
  reason: string;
  plan?: Pick<PlanResult, 'markdown' | 'sourcePath' | 'stdoutSummary'>;
  error?: HeavyAgentArtifactError;
}): PendingUserDecision {
  const source = input.plan?.sourcePath ?? input.error?.sourcePath ?? 'stdout';
  return {
    id: `plan-artifact-failure:${slug(input.phase)}`,
    source: 'plan_artifact_failure',
    question: `The heavy agent did not provide a usable plan artifact during ${input.phase}. What should VibeCodingAssistant-ElonMa do next?`,
    rationale: `VibeCodingAssistant-ElonMa paused before sending an empty or unusable plan onward. Source: ${source}. Reason: ${input.reason}`,
    options: [
      {
        id: 'A',
        label: 'Retry planning',
        impact: 'Clears the failed attempt and reruns planning from the original task plus the recorded retry direction.',
      },
      {
        id: 'B',
        label: 'Stop task',
        impact: 'Stops this task so you can inspect configuration or restart manually later.',
      },
    ],
    recommendedOptionId: 'A',
    recommendationReason: 'Retrying is appropriate after fixing the heavy-agent output path or prompt contract.',
    allowFreeform: true,
  };
}

function renderAgentDecisionRequestLog(source: PendingUserDecisionSource, decision: PendingUserDecision): string {
  return [
    `agent user decision requested (${source})`,
    `decision id: ${decision.id}`,
    `question: ${decision.question}`,
    `options: ${decision.options.map((option) => `${option.id}. ${option.label}`).join(' | ')}`,
    decision.recommendedOptionId ? `recommended: ${decision.recommendedOptionId}` : undefined,
    decision.recommendationReason ? `recommendation reason: ${decision.recommendationReason}` : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');
}

function isDegeneratePlanBody(markdown: string): boolean {
  const trimmed = markdown.trim();
  if (!trimmed) return true;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length === 1 && /^Plan written to\s+`?.+?\.md`?\.?$/i.test(lines[0] ?? '');
}

function slug(value: string): string {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'plan-artifact-failure';
}

function renderExtraHighCapNote(round: number, ledger?: BlockerLedger): string {
  const activeCount = ledger ? activeBlockers(ledger).length : 0;
  return `> Note: Extra High planning paused after round ${round} with ${activeCount} active blocker(s). See blocker-ledger.md and plan-rounds-log.md.`;
}

function stripExtraHighCapNote(markdown: string): string {
  return markdown
    .replace(/^> Note: Reviewer still flagged issues at round \d+ — Extra High planning is paused for user direction\. See plan-rounds-log\.md\.\s*\n+/u, '')
    .replace(/^> Note: Extra High planning paused after round \d+ with \d+ active blocker\(s\)\. See blocker-ledger\.md and plan-rounds-log\.md\.\s*\n+/u, '')
    .trim();
}

function makeExtraHighContinuationDecision(round: number, ledger?: BlockerLedger): PendingUserDecision {
  const activeCount = ledger ? activeBlockers(ledger).length : 0;
  const summary = ledger ? renderUnclosedBlockerSummary(ledger) : 'No blocker ledger is available.';
  return {
    id: `extra-high-planning:round-${round}`,
    source: 'extra_high_planning',
    question: `Extra High still has ${activeCount} active blocker(s) after round ${round}. What should happen next?`,
    rationale: [
      'A plan with unresolved reviewer blockers should not enter normal approval automatically.',
      'Active blockers:',
      summary,
    ].join('\n'),
    options: [
      {
        id: 'A',
        label: 'Continue one round',
        impact: 'Runs one additional Planner/Reviewer round from the latest reviewed plan; Architect must respond to the active ledger.',
      },
      {
        id: 'B',
        label: 'Restart planning',
        impact: 'Starts a fresh Extra High planning pass from the original task plus your direction and clears the current blocker ledger.',
      },
      {
        id: 'C',
        label: 'Execute current plan',
        impact: `Approves and implements the latest plan despite ${activeCount} active blocker(s), recording this as a user override.`,
      },
    ],
    allowFreeform: true,
  };
}

export function isReviewerApproval(markdown: string): boolean {
  const text = markdown.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return false;

  const stripped = text
    .replace(/no\s+blocking\s+issues?/g, ' ')
    .replace(/no\s+blockers?/g, ' ')
    .replace(/no\s+must[-\s]?fix/g, ' ');

  const blockerRe = /\b(must[-\s]?fix|blockers?|blocking issues?)\b/;
  if (blockerRe.test(stripped)) return false;

  const approvalRe = /(no blocking issues?|no blockers?|no issues?|approved|looks good|lgtm|no further (comments|changes)|通过|没有?问题|没有?阻塞|无阻塞|批准)/;
  return approvalRe.test(text);
}

type ParsedWorkflowReply =
  | { kind: 'approve'; instruction?: string }
  | { kind: 'reject' }
  | { kind: 'revise'; instruction: string }
  | { kind: 'restart'; instruction: string }
  | { kind: 'difficulty'; level: WorkflowDifficulty; instruction?: string }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'summary' }
  | { kind: 'accept'; instruction?: string }
  | { kind: 'note'; note: string }
  | { kind: 'ambiguous'; reason: string; useLlmFallback: boolean };

function parseWorkflowReply(input: string): ParsedWorkflowReply {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) return { kind: 'ambiguous', reason: 'Empty reply.', useLlmFallback: false };

  if (/^status$/i.test(text)) return { kind: 'status' };
  if (/^summary$/i.test(text)) return { kind: 'summary' };
  if (/^stop$/i.test(text)) return { kind: 'stop' };
  const acceptMatch = text.match(/^(?:accept|accepted)(?:\s*:\s*(.+))?$/i);
  if (acceptMatch) return { kind: 'accept', ...(acceptMatch[1]?.trim() ? { instruction: acceptMatch[1].trim() } : {}) };
  const difficultyMatch = text.match(/^(low|medium|high|extra[-_ ]?high)(?:\s*:\s*(.+))?$/i);
  if (difficultyMatch?.[1]) {
    const level = normalizeWorkflowDifficulty(difficultyMatch[1]);
    if (!level) return { kind: 'ambiguous', reason: 'Reply did not match a known workflow difficulty.', useLlmFallback: false };
    return {
      kind: 'difficulty',
      level,
      ...(difficultyMatch[2]?.trim() ? { instruction: difficultyMatch[2].trim() } : {}),
    };
  }
  const approveMatch = text.match(/^(?:approve A|approve|approved|A|yes|y)(?:\s*:\s*(.+))?$/i);
  if (approveMatch) return { kind: 'approve', ...(approveMatch[1]?.trim() ? { instruction: approveMatch[1].trim() } : {}) };
  if (/^(?:reject B|reject|B|no|n)$/i.test(text)) return { kind: 'reject' };

  const noteMatch = text.match(/^note\s*:\s*(.+)$/i);
  if (noteMatch?.[1]?.trim()) return { kind: 'note', note: noteMatch[1].trim() };

  const restartMatch = text.match(/^(?:restart|redesign|rerun|start over|重新开始|重跑|从头跑|重新规划|重新设计|重启)\s*[:：]\s*(.+)$/i);
  if (restartMatch?.[1]?.trim()) return { kind: 'restart', instruction: restartMatch[1].trim() };

  if (/^(?:restart|redesign|rerun|start over|重新开始|重跑|从头跑|重新规划|重新设计|重启)$/i.test(text)) {
    return {
      kind: 'ambiguous',
      reason: 'Restart replies must include the new prompt after a colon, for example: restart: use the production code path in the verification report.',
      useLlmFallback: false,
    };
  }

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
    state.implementationFollowup ? `Implementation follow-up: round ${state.implementationFollowup.round} (${state.implementationFollowup.source})` : undefined,
    state.pendingUserPrompt ? `Pending user prompt: ${state.pendingUserPrompt}` : undefined,
  ].filter(Boolean).join('\n');
}

function renderDifficultyPrompt(): string {
  return [
    'Choose workflow difficulty:',
    '- low: simple copy, text, color, or tiny changes. Runs the initial Architect plan, copies it to revised-plan, and skips only plan review and revision instructions.',
    '- medium: default flow. Codex plans, Claude reviews, Codex revises.',
    '- high: complex or risky work. Claude plans/revises, Codex reviews the plan.',
    '- extra high: high 流程 + Planner ↔ Reviewer 初始最多 3 轮；如果仍有 blocking concerns，会先问你是否继续下一轮.',
    'Reply with exactly one of: low, medium, high, extra high.',
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
  const { pendingUserPrompt: _pendingUserPrompt, pendingUserDecision: _pendingUserDecision, ...rest } = state;
  return rest;
}

function normalizeFinalReviewRoute(
  route: AssistantRouteResult,
  finalReview: string,
  verificationLog: string,
): { route: AssistantRouteResult; decisionLogNote?: string } {
  if (route.route !== 'ask_user_direction') return { route };
  const routeText = [route.reason, route.userPrompt].filter(Boolean).join('\n');
  if (!looksLikeTechnicalFinalReviewSignal(routeText) && !looksLikeContainedFinalReviewImplementationDefect([
    finalReview,
    verificationLog,
    routeText,
  ].filter(Boolean).join('\n'))) return { route };
  return {
    route: {
      route: 'route_to_implementer',
      reason: route.reason,
    },
    decisionLogNote: [
      'final review routing normalized: ask_user_direction -> route_to_implementer',
      'reason: final review described a contained technical/test/build implementation defect, not a product/scope/direction decision',
      `advisor reason: ${route.reason}`,
    ].join('\n'),
  };
}

function looksLikeContainedFinalReviewImplementationDefect(context: string): boolean {
  const text = context.toLocaleLowerCase();
  const hasTechnicalFailure = looksLikeTechnicalFinalReviewSignal(text);
  if (!hasTechnicalFailure) return false;

  const asksForProductDecision = [
    /\b(?:product decision|scope decision|scope tradeoff|ux decision|pricing|cost|policy|business|user-facing tradeoff)\b/,
    /产品|范围|方向|取舍|定价|成本|策略|用户体验/,
  ].some((pattern) => pattern.test(text));
  return !asksForProductDecision;
}

function looksLikeTechnicalFinalReviewSignal(context: string): boolean {
  const text = context.toLocaleLowerCase();
  const hasTechnicalFailure = [
    /\b(?:test|tests|unit|integration|playwright|vitest|eslint|lint|build|typecheck|tsc)\b/,
    /\b(?:fail|fails|failed|failing|failure|assertionerror|error|regression|bug|defect|broken|runtime|cleanup)\b/,
    /测试|失败|构建|类型检查|回归|缺陷|实现问题/,
  ].some((pattern) => pattern.test(text));
  return hasTechnicalFailure;
}

function isFinalReviewUserDirection(state: TaskState): boolean {
  return state.lastDecision === 'ask_user_direction' && Boolean(state.artifacts['final-review']);
}

function isAcceptCurrentWorktreeDirection(answer: string, selectedOption?: PendingUserDecisionOption): boolean {
  const normalized = [
    answer,
    selectedOption?.label,
    selectedOption?.impact,
  ].filter(Boolean).join('\n').trim().toLocaleLowerCase();
  return /^(?:1|option\s*1|选项\s*1|一)$/.test(normalized)
    || normalized.includes('接受现状')
    || normalized.includes('接受当前')
    || normalized.includes('accept current')
    || normalized.includes('as-is')
    || normalized.includes('不用回退')
    || normalized.includes('不需要回退');
}

function isFinalReviewFollowupCapDirection(state: TaskState): boolean {
  return state.status === 'waiting_user_direction'
    && state.pendingUserDecision?.id.startsWith('final-review-followup-cap:') === true;
}

function isFinalReviewFollowupStopDirection(answer: string, selectedOption?: PendingUserDecisionOption): boolean {
  if (selectedOption?.id === 'D') return true;
  return /^(?:stop|d)$/i.test(answer.trim());
}

function isExtraHighExecuteCurrentPlanDirection(answer: string, selectedOption?: PendingUserDecisionOption): boolean {
  if (selectedOption?.id === 'C') return true;
  if (selectedOption) return false;
  const normalized = answer.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (normalized.length > 160) return false;
  const compact = normalized.replace(/\s+/g, '');
  return /(?:execute|implement|run|use|approve).*(?:current|this|latest).*(?:plan|方案)/i.test(normalized)
    || /(?:current|this|latest).*(?:plan|方案).*(?:execute|implement|run|use|approve)/i.test(normalized)
    || /(?:直接|现在|马上)?(?:执行|实施|实现|批准|照做|按).*(?:当前|这个|這個|这版|最新版|latest)?(?:plan|方案|计划|計劃)/.test(compact)
    || /(?:按|照)(?:当前|这个|這個|这版|最新版)?(?:plan|方案|计划|計劃)(?:执行|做|实施|实现)/.test(compact);
}

function hasArchitectNeedsUserDecision(plan: PlanResult): boolean {
  return Boolean(plan.architectBlockerResponses?.some((response) => response.status === 'needs_user_decision'));
}

function appendWorkflowInstruction(state: TaskState, instruction?: string): TaskState {
  const trimmed = instruction?.trim();
  if (!trimmed) return state;
  return {
    ...state,
    requestedChanges: [...state.requestedChanges, trimmed],
  };
}

function clearFollowupScope(state: TaskState): TaskState {
  const { implementationFollowup: _implementationFollowup, ...rest } = state;
  return rest;
}

function makeFinalReviewFollowupScope(state: TaskState, reason: string): NonNullable<TaskState['implementationFollowup']> {
  const completedRounds = state.implementationFollowupHistory?.map((entry) => entry.round) ?? [];
  const nextRound = Math.max(0, ...completedRounds, state.implementationFollowup?.round ?? 0) + 1;
  return {
    source: 'final_review',
    round: nextRound,
    reason: reason.trim() || 'Final review found blocking implementation issues.',
    createdAt: new Date().toISOString(),
  };
}

function makeFinalReviewFollowupExecutionUnit(round: number): ExecutionUnitState {
  return {
    index: -1,
    slug: 'final-review-followup',
    name: `Final Review Follow-up (round ${round})`,
    status: 'Not Started',
    fileName: '',
  };
}

function makeFinalReviewFollowupCapDecision(state: TaskState, reason: string): PendingUserDecision {
  const trimmed = reason.trim() || 'Final review still found blocking implementation issues after a follow-up.';
  const nextRound = makeFinalReviewFollowupScope(state, trimmed).round;
  return {
    id: `final-review-followup-cap:round-${nextRound}`,
    source: 'final_review',
    question: 'Final review still has implementation blockers after one follow-up. What should VibeCodingAssistant-ElonMa do next?',
    rationale: [
      'VibeCodingAssistant-ElonMa already ran one scoped Final Review Follow-up.',
      'Another automatic retry could loop, so this needs explicit user direction.',
      '',
      'Latest final review reason:',
      trimmed,
    ].join('\n'),
    options: [
      {
        id: 'A',
        label: 'Run another follow-up',
        impact: 'Creates one more scoped Final Review Follow-up unit, then runs verification and final review again.',
      },
      {
        id: 'B',
        label: 'Send back to planning',
        impact: 'Reopens planning so the plan can address the final-review concern before more implementation work.',
      },
      {
        id: 'C',
        label: 'Accept with deferred issues',
        impact: 'Records the unresolved final-review issue in deferred-issues.md and moves to user acceptance.',
      },
      {
        id: 'D',
        label: 'Stop task',
        impact: 'Stops the task without recording acceptance.',
      },
    ],
    recommendedOptionId: 'A',
    recommendationReason: 'A second scoped follow-up is reasonable only with explicit user approval after the first retry failed.',
    allowFreeform: true,
  };
}

function makeFinalReviewRoutingFallbackDecision(reason: string, userPrompt?: string): PendingUserDecision {
  const trimmed = reason.trim() || 'Final review needs a user direction before the workflow can continue.';
  return {
    id: 'final-review-routing:fallback',
    source: 'final_review',
    question: 'Final review needs a next-step decision. What should VibeCodingAssistant-ElonMa do?',
    rationale: [
      'The final-review routing step asked for user direction but did not provide structured options.',
      'VibeCodingAssistant-ElonMa generated safe fallback options instead of exposing the internal formatting failure.',
      '',
      'Latest final review reason:',
      trimmed,
      userPrompt?.trim() ? '' : undefined,
      userPrompt?.trim() ? 'Advisor prompt:' : undefined,
      userPrompt?.trim(),
    ].filter((line): line is string => line !== undefined).join('\n'),
    options: [
      {
        id: 'A',
        label: 'Run implementation follow-up',
        impact: 'Creates a scoped Final Review Follow-up unit and asks the implementer to fix the issue.',
      },
      {
        id: 'B',
        label: 'Send back to planning',
        impact: 'Reopens planning if the final-review issue shows the plan itself needs redesign.',
      },
      {
        id: 'C',
        label: 'Accept with deferred issues',
        impact: 'Records the unresolved final-review issue in deferred-issues.md and moves to user acceptance.',
      },
      {
        id: 'D',
        label: 'Stop task',
        impact: 'Stops the task without recording acceptance.',
      },
    ],
    recommendedOptionId: 'A',
    recommendationReason: 'For implementation or verification failures, another scoped follow-up is usually the safest next step.',
    allowFreeform: true,
  };
}

function finalReviewFollowupReasonFromDecision(decision: PendingUserDecision | undefined): string | undefined {
  const rationale = decision?.rationale;
  if (!rationale) return undefined;
  const marker = 'Latest final review reason:';
  const index = rationale.indexOf(marker);
  if (index < 0) return undefined;
  return rationale.slice(index + marker.length).trim() || undefined;
}

function renderDeferredFinalReviewIssues(state: TaskState, userDirection: string): string {
  const reason = finalReviewFollowupReasonFromDecision(state.pendingUserDecision)
    ?? state.pendingUserPrompt
    ?? 'Final review issue deferred by user direction.';
  return [
    '# Deferred Issues',
    '',
    'The user chose to accept the current worktree with unresolved final-review issues recorded.',
    '',
    '## User Direction',
    '',
    userDirection,
    '',
    '## Deferred Final Review Issue',
    '',
    reason,
  ].join('\n');
}

function restartFromPlanningState(state: TaskState, instruction: string, reply: string): TaskState {
  const {
    acceptedAt: _acceptedAt,
    approvedAt: _approvedAt,
    blockerLedger: _blockerLedger,
    currentExecutionIndex: _currentExecutionIndex,
    executionMode: _executionMode,
    implementationFollowup: _implementationFollowup,
    implementationFollowupHistory: _implementationFollowupHistory,
    extraHighContinuationFromReview: _extraHighContinuationFromReview,
    extraHighRoundLimit: _extraHighRoundLimit,
    pendingUserPrompt: _pendingUserPrompt,
    pendingUserDecision: _pendingUserDecision,
    planSummary: _planSummary,
    stoppedReason: _stoppedReason,
    ...rest
  } = state;
  return {
    ...rest,
    status: 'planning_requested',
    revisionRound: 0,
    reviewerRunCount: 0,
    executionQueue: [],
    requestedChanges: [...state.requestedChanges, `Restart/redesign prompt:\n${instruction}`],
    lastDecision: reply,
    updatedAt: new Date().toISOString(),
  };
}

function resetPlanningAfterUserDecision(state: TaskState, instruction: string, reply: string): TaskState {
  const {
    acceptedAt: _acceptedAt,
    approvedAt: _approvedAt,
    blockerLedger: _blockerLedger,
    currentExecutionIndex: _currentExecutionIndex,
    executionMode: _executionMode,
    implementationFollowup: _implementationFollowup,
    extraHighContinuationFromReview: _extraHighContinuationFromReview,
    extraHighRoundLimit: _extraHighRoundLimit,
    pendingUserPrompt: _pendingUserPrompt,
    pendingUserDecision: _pendingUserDecision,
    planSummary: _planSummary,
    stoppedReason: _stoppedReason,
    ...rest
  } = state;
  return {
    ...rest,
    status: 'planning_requested',
    revisionRound: 0,
    reviewerRunCount: 0,
    executionQueue: [],
    requestedChanges: [...state.requestedChanges, instruction],
    lastDecision: reply,
    updatedAt: new Date().toISOString(),
  };
}

function renderFinalReviewImplementationChange(reason: string): string {
  const trimmed = reason.trim() || 'Final review found blocking implementation issues.';
  return `Final review requested implementation follow-up:\n${trimmed}`;
}

function renderFinalReviewImplementationReroutePrompt(reason: string): string {
  const trimmed = reason.trim() || 'Final review found blocking implementation issues.';
  return [
    'Final review 未通过：Assistant final review 发现刚才的系统实现结果仍有阻塞问题。',
    `返工输入：${trimmed}`,
    '这不是要求你手动改代码；问题已经加入实现返工清单。',
    '如果继续由系统修复，请回复 approve A、yes 或「继续修复」；也可以回复 stop 暂停。',
  ].join('\n');
}

function renderFinalReviewPlanningChange(reason: string): string {
  const trimmed = reason.trim() || 'Final review found a plan or verification-design issue.';
  return `Final review requested planning follow-up:\n${trimmed}`;
}

function renderFinalReviewUserDirectionPrompt(reason: string, userPrompt?: string): string {
  const trimmedReason = reason.trim() || 'Final review needs a user decision before the workflow can continue.';
  const trimmedPrompt = userPrompt?.trim();
  return [
    'Final review 需要你做一个产品/范围/方向决定。',
    `原因：${trimmedReason}`,
    trimmedPrompt ? `需要你确认：${trimmedPrompt}` : undefined,
  ].filter(Boolean).join('\n');
}

function readPlanMetadata(revisedPlan: string): { verificationCommands: string[]; planPackDraft?: PlanResult['planPackDraft'] } {
  const match = revisedPlan.match(/<!-- assistant-plan-metadata\s*([\s\S]*?)\s*assistant-plan-metadata -->/);
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
  return markdown.replace(/\n*<!-- assistant-plan-metadata[\s\S]*?assistant-plan-metadata -->\s*$/m, '').trim();
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
