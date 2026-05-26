import { basename } from 'node:path';

import type { ArtifactStore } from './artifacts.js';
import type { AssistantAdapter } from './adapters.js';
import { getAllowedActions } from './allowedActions.js';
import type {
  ArtifactName,
  IntentName,
  AssistantConfig,
  OrchestratorDecision,
  OrchestratorRuleHint,
  TaskState,
  WorkflowDifficulty,
} from './types.js';
import type { WorkflowResult, WorkflowService } from './workflow.js';

interface OrchestratorFile {
  path: string;
  name: string;
}

export type OrchestratorAction =
  | { kind: 'respond'; text: string }
  | { kind: 'approve_implementation'; instruction?: string }
  | { kind: 'forward_to_workflow'; intent: Exclude<IntentName, 'status' | 'summary' | 'ask' | 'unknown'>; instruction?: string; difficulty?: WorkflowDifficulty }
  | { kind: 'show_artifact'; artifact: 'agent-prompt-preview' }
  | { kind: 'ask_clarification'; question: string }
  | { kind: 'wait_for_user'; reason: string };

export type OrchestratorTurn =
  | { kind: 'reply'; rawMessage: string; state: TaskState; files?: OrchestratorFile[]; auditAction?: string; auditMetadata?: Record<string, unknown> }
  | { kind: 'background'; startedMessage: string; state: TaskState; run: () => Promise<WorkflowResult>; auditAction?: string; auditMetadata?: Record<string, unknown> };

export interface OrchestratorDeps {
  assistant: AssistantAdapter;
  workflow: WorkflowService;
  store: ArtifactStore;
  config: AssistantConfig;
}

export interface OrchestratorInput {
  taskId: string;
  state: TaskState;
  userMessage: string;
  ruleHint?: OrchestratorRuleHint;
}

const MAX_DECISION_ATTEMPTS = 3;
const HIGH_RISK_CONFIDENCE = 0.8;

export async function orchestrateTaskMessage(input: OrchestratorInput, deps: OrchestratorDeps): Promise<OrchestratorTurn> {
  const first = await decideValidAction(input.state, input.userMessage, input.ruleHint, undefined, deps);
  if (first.action.kind === 'show_artifact') {
    return renderArtifactReply(input.taskId, first.action.artifact, deps);
  }
  if (first.action.kind === 'respond' || first.action.kind === 'ask_clarification' || first.action.kind === 'wait_for_user') {
    return {
      kind: 'reply',
      rawMessage: terminalActionText(first.action),
      state: input.state,
      auditAction: `orchestrator:${first.action.kind}`,
      auditMetadata: decisionAuditMetadata(first.decision),
    };
  }

  const mutatingAction = first.action;
  return {
    kind: 'background',
    auditAction: `orchestrator:${first.action.kind}`,
    auditMetadata: decisionAuditMetadata(first.decision),
    state: input.state,
    startedMessage: first.decision.text ?? '收到，我按当前 workflow 继续推进；跑完会把下一步发到这里。',
    run: () => dispatchMutatingAction(input.taskId, input.userMessage, mutatingAction, deps),
  };
}

async function decideValidAction(
  state: TaskState,
  userMessage: string,
  ruleHint: OrchestratorRuleHint | undefined,
  previousActionInThisTurn: OrchestratorDecision | undefined,
  deps: OrchestratorDeps,
): Promise<{ action: OrchestratorAction; decision: OrchestratorDecision }> {
  let rejectionReason: string | undefined;
  for (let attempt = 0; attempt < MAX_DECISION_ATTEMPTS; attempt += 1) {
    const decision = await decideNextAction(state, userMessage, ruleHint, previousActionInThisTurn, rejectionReason, deps);
    const action = normalizeDecision(decision);
    const validation = validateAction(action, decision, state);
    if (validation.ok) return { action, decision };
    rejectionReason = validation.reason;
  }

  const decision: OrchestratorDecision = {
    action: 'wait_for_user',
    reason: rejectionReason ?? 'orchestrator decision was not allowed',
    text: '我理解你想推进，但刚才的编排动作没有通过当前 workflow 护栏，所以我先不动状态。请你再明确说一次。',
    confidence: 1,
  };
  return { action: { kind: 'wait_for_user', reason: decision.text ?? decision.reason ?? 'waiting for user' }, decision };
}

async function decideNextAction(
  state: TaskState,
  userMessage: string,
  ruleHint: OrchestratorRuleHint | undefined,
  previousActionInThisTurn: OrchestratorDecision | undefined,
  rejectionReason: string | undefined,
  deps: OrchestratorDeps,
): Promise<OrchestratorDecision> {
  try {
    const artifactName = latestArtifactName(state);
    return await deps.assistant.decideNextAction({
      state: {
        taskId: state.taskId,
        title: state.title,
        status: state.status,
        revisionRound: state.revisionRound,
        reviewerRunCount: state.reviewerRunCount,
        ...(state.difficulty ? { difficulty: state.difficulty } : {}),
        ...(state.pendingUserPrompt ? { pendingUserPrompt: state.pendingUserPrompt } : {}),
        ...(state.pendingUserDecision ? { pendingUserDecision: state.pendingUserDecision } : {}),
      },
      allowedActions: getAllowedActions(state),
      requestedChanges: state.requestedChanges,
      recentDecisionLog: await recentDecisionLog(state, deps.store),
      ...(artifactName ? { latestArtifactName: artifactName } : {}),
      latestUserMessage: userMessage,
      ...(ruleHint ? { ruleHint } : {}),
      ...(previousActionInThisTurn ? { previousActionInThisTurn } : {}),
      ...(rejectionReason ? { rejectionReason } : {}),
      config: deps.config,
    });
  } catch (error) {
    return {
      action: 'wait_for_user',
      reason: error instanceof Error ? error.message : String(error),
      text: '我收到你的消息了，但刚才调用编排器失败，所以没有推进 workflow。请你再明确说一次。',
      confidence: 0,
    };
  }
}

function normalizeDecision(decision: OrchestratorDecision): OrchestratorAction {
  switch (decision.action) {
    case 'respond':
      return { kind: 'respond', text: decision.text ?? '收到。' };
    case 'approve_implementation':
      return { kind: 'approve_implementation', ...(decision.instruction ? { instruction: decision.instruction } : {}) };
    case 'forward_to_workflow':
      return {
        kind: 'forward_to_workflow',
        intent: workflowIntent(decision.intent),
        ...(decision.instruction ? { instruction: decision.instruction } : {}),
        ...(decision.difficulty ? { difficulty: decision.difficulty } : {}),
      };
    case 'show_artifact':
      return { kind: 'show_artifact', artifact: 'agent-prompt-preview' };
    case 'ask_clarification':
      return { kind: 'ask_clarification', question: decision.question ?? decision.text ?? '请你再明确一下要怎么推进。' };
    case 'wait_for_user':
      return { kind: 'wait_for_user', reason: decision.reason ?? decision.text ?? '等待用户进一步确认。' };
  }
}

function workflowIntent(intent: IntentName | undefined): Exclude<IntentName, 'status' | 'summary' | 'ask' | 'unknown'> {
  if (
    intent === 'approve' ||
    intent === 'reject' ||
    intent === 'revise' ||
    intent === 'difficulty' ||
    intent === 'accept' ||
    intent === 'note' ||
    intent === 'restart' ||
    intent === 'stop'
  ) {
    return intent;
  }
  return 'approve';
}

function validateAction(action: OrchestratorAction, decision: OrchestratorDecision, state: TaskState): { ok: true } | { ok: false; reason: string } {
  const allowedActions = getAllowedActions(state);
  const hasAllowed = (intent: IntentName) => allowedActions.some((allowed) => allowed.id === intent);
  switch (action.kind) {
    case 'respond':
    case 'ask_clarification':
    case 'wait_for_user':
      return { ok: true };
    case 'approve_implementation':
      if (state.status !== 'ready_for_decision' && state.status !== 'implementation_approved') return { ok: false, reason: `approve_implementation is not valid from ${state.status}` };
      if (!hasAllowed('approve')) return { ok: false, reason: 'approve_implementation requires approve to be allowed' };
      if (decision.confidence < HIGH_RISK_CONFIDENCE) return { ok: false, reason: 'approve_implementation requires confidence >= 0.8' };
      return { ok: true };
    case 'forward_to_workflow':
      if (!hasAllowed(action.intent)) return { ok: false, reason: `forward_to_workflow intent ${action.intent} is not allowed` };
      if (action.intent === 'difficulty' && !action.difficulty) return { ok: false, reason: 'difficulty intent requires difficulty' };
      if ((action.intent === 'accept' || action.intent === 'reject' || action.intent === 'stop') && decision.confidence < HIGH_RISK_CONFIDENCE) {
        return { ok: false, reason: `${action.intent} requires confidence >= 0.8` };
      }
      return { ok: true };
    case 'show_artifact':
      if (!hasAllowed('ask')) return { ok: false, reason: 'show_artifact requires ask to be allowed' };
      return { ok: true };
  }
}

function terminalActionText(action: Extract<OrchestratorAction, { kind: 'respond' | 'ask_clarification' | 'wait_for_user' }>): string {
  if (action.kind === 'respond') return action.text;
  if (action.kind === 'ask_clarification') return action.question;
  return action.reason;
}

async function dispatchMutatingAction(
  taskId: string,
  userMessage: string,
  action: Exclude<OrchestratorAction, { kind: 'respond' | 'ask_clarification' | 'wait_for_user' | 'show_artifact' }>,
  deps: OrchestratorDeps,
): Promise<WorkflowResult> {
  if (action.kind === 'approve_implementation') {
    return deps.workflow.reply(taskId, instructionReply('approve A', action.instruction));
  }
  return deps.workflow.reply(taskId, workflowReplyForAction(action, userMessage));
}

function workflowReplyForAction(action: Extract<OrchestratorAction, { kind: 'forward_to_workflow' }>, userMessage: string): string {
  switch (action.intent) {
    case 'approve':
      return instructionReply('approve A', action.instruction);
    case 'reject':
      return 'reject B';
    case 'revise':
      return `revise C: ${action.instruction ?? userMessage}`;
    case 'difficulty':
      return instructionReply(action.difficulty ?? 'low', action.instruction);
    case 'accept':
      return instructionReply('accept', action.instruction);
    case 'note':
      return `note: ${action.instruction ?? userMessage}`;
    case 'restart':
      return `restart: ${action.instruction ?? userMessage}`;
    case 'stop':
      return 'stop';
  }
}

function instructionReply(base: string, instruction?: string): string {
  return instruction ? `${base}: ${instruction}` : base;
}

async function renderArtifactReply(taskId: string, artifact: 'agent-prompt-preview', deps: OrchestratorDeps): Promise<OrchestratorTurn> {
  const before = await deps.store.loadState(taskId);
  const content = await deps.workflow.showArtifact(taskId, artifact);
  const after = await deps.store.loadState(taskId);
  return {
    kind: 'reply',
    rawMessage: [`${artifact}:`, '', shorten(content, 1200)].join('\n'),
    state: after,
    ...(after.artifacts[artifact] ? { files: [{ path: after.artifacts[artifact], name: basename(after.artifacts[artifact]) }] } : {}),
    auditAction: 'orchestrator:show_artifact',
    auditMetadata: { artifact, statusBefore: before.status, statusAfter: after.status },
  };
}

async function recentDecisionLog(state: TaskState, store: ArtifactStore): Promise<string> {
  const content = await store.readArtifact(state, 'decision-log').catch(() => '');
  return content.slice(-1000);
}

function latestArtifactName(state: TaskState): ArtifactName | undefined {
  const names = Object.keys(state.artifacts) as ArtifactName[];
  return names.at(-1);
}

function decisionAuditMetadata(decision: OrchestratorDecision): Record<string, unknown> {
  return {
    action: decision.action,
    confidence: decision.confidence,
    ...(decision.intent ? { intent: decision.intent } : {}),
    ...(decision.difficulty ? { difficulty: decision.difficulty } : {}),
    ...(decision.userConsentForContinuation !== undefined ? { userConsentForContinuation: decision.userConsentForContinuation } : {}),
    ...(decision.reasoning ? { reasoning: decision.reasoning } : {}),
  };
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n...`;
}
