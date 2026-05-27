import { basename } from 'node:path';

import { ArtifactStore } from './artifacts.js';
import type { AssistantAdapter } from './adapters.js';
import { getAllowedActions, humanStageName } from './allowedActions.js';
import { normalizeWorkflowDifficulty } from './difficulty.js';
import { orchestrateTaskMessage, type OrchestratorTurn } from './orchestrator.js';
import { ProjectKnowledgeService } from './projectKnowledge.js';
import { getDefaultProjectId } from './projects.js';
import type {
  AllowedAction,
  ArtifactName,
  ControlChatResult,
  IntentResult,
  AssistantConfig,
  TaskProposal,
  TaskState,
} from './types.js';
import type { WorkflowResult, WorkflowService } from './workflow.js';

const ARTIFACT_NAMES: ArtifactName[] = [
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
  'implementation-log',
  'git-pre-status',
  'git-post-status',
  'git-pre-diff',
  'git-post-diff',
  'followup-git-pre-status',
  'followup-git-pre-diff',
  'followup-git-post-status',
  'followup-git-post-diff',
  'test-build-log',
  'deferred-issues',
  'final-review',
  'agent-prompts',
  'agent-prompt-preview',
  'final-report',
];

const TASK_CONTEXT_ARTIFACT_NAMES = ARTIFACT_NAMES.filter((name) => name !== 'agent-prompts' && name !== 'agent-prompt-preview');

export const CLARIFY_INTENT_MESSAGE = [
  '我还没完全确定你的意思，所以没有推进 workflow。',
  '你可以直接用自然语言说：同意、需要改哪里、高难度、现在到哪了、验收通过。',
].join('\n');

export const NO_TASK_TO_STOP_MESSAGE = '这个聊天里没有正在绑定的任务可以停止。';

type GlobalCommand = 'status' | 'summary' | 'help' | 'stop';

export interface TaskRequest {
  title: string;
  task: string;
  projectId?: string;
}

export interface OutboundFile {
  path: string;
  name: string;
}

export interface OutboundMessage {
  text: string;
  files?: OutboundFile[];
}

export type ConversationTurn =
  | { kind: 'reply'; messages: OutboundMessage[]; auditAction?: string; auditMetadata?: Record<string, unknown> }
  | { kind: 'background'; startedMessage: OutboundMessage; run: () => Promise<WorkflowResult>; auditAction?: string; auditMetadata?: Record<string, unknown> };

export type BackgroundConversationTurn = Extract<ConversationTurn, { kind: 'background' }>;

export type ControlConversationTurn =
  | { kind: 'reply'; message: OutboundMessage }
  | { kind: 'proposal'; message: OutboundMessage; proposal: TaskProposal }
  | { kind: 'confirm_pending_proposal'; message?: OutboundMessage }
  | { kind: 'cancel_pending_proposal'; message?: OutboundMessage };

export class AssistantConversationService {
  private readonly projectKnowledge: ProjectKnowledgeService;

  constructor(
    private readonly workflow: WorkflowService,
    private readonly store: ArtifactStore,
    private readonly assistant?: AssistantAdapter,
    private readonly config?: AssistantConfig,
    private readonly options: { orchestratorEnabled?: boolean } = {},
  ) {
    this.projectKnowledge = new ProjectKnowledgeService(store.assistantRoot);
  }

  async createTask(input: TaskRequest): Promise<WorkflowResult> {
    return this.workflow.createTask(input);
  }

  startPlanning(taskId: string): BackgroundConversationTurn {
    return {
      kind: 'background',
      startedMessage: { text: '任务已创建，请先选择工作难度：low、medium、high 或 extra high。' },
      run: () => this.workflow.planTask(taskId),
    };
  }

  async routeTaskMessage(taskId: string, text: string): Promise<ConversationTurn> {
    const trimmed = stripMentions(text).trim();
    if (!trimmed) {
      return { kind: 'reply', messages: [{ text: '我收到的是空消息。直接说你的决定或问题就行。' }] };
    }

    const showArtifact = parseShowArtifact(trimmed);
    if (showArtifact) {
      return { kind: 'reply', auditAction: 'show_artifact', messages: [await this.renderArtifact(taskId, showArtifact)] };
    }

    const state = await this.store.loadState(taskId);
    const explicitCommand = parseExplicitWorkflowCommand(trimmed, state);
    if (this.options.orchestratorEnabled && this.assistant && this.config) {
      if (explicitCommand && ['status', 'summary', 'stop'].includes(explicitCommand.intent)) {
        return this.executeExplicitWorkflowCommand(taskId, state, explicitCommand);
      }
      return this.orchestratorTurnToConversationTurn(await orchestrateTaskMessage({
        taskId,
        state,
        userMessage: trimmed,
        ...(explicitCommand ? { ruleHint: explicitCommand } : {}),
      }, {
        assistant: this.assistant,
        workflow: this.workflow,
        store: this.store,
        config: this.config,
      }));
    }

    if (explicitCommand) {
      return this.executeExplicitWorkflowCommand(taskId, state, explicitCommand);
    }

    const classified = await this.classifyTaskIntent(trimmed, state);
    if ('turn' in classified) return classified.turn;

    const intent = normalizeIntentForState(classified.intent, state);
    const allowedActions = getAllowedActions(state);
    const allowed = allowedActions.some((action) => action.id === intent.intent);
    if (!allowed) {
      const fallbackQuestion = conversationalFallbackIntent(trimmed, intent, allowedActions);
      if (fallbackQuestion) {
        return this.executeIntent(taskId, trimmed, state, fallbackQuestion);
      }
      return {
        kind: 'reply',
        auditAction: `intent:${intent.intent}:blocked`,
        auditMetadata: intentAuditMetadata(intent),
        messages: [await this.composeMessage({
          rawMessage: [
            intent.userFacingInterpretation,
            `不过当前阶段是「${humanStageName(state.status)}」，这个动作还不能执行。`,
            `现在可以：${formatAllowedActions(allowedActions)}`,
          ].join('\n'),
          state,
        })],
      };
    }

    if (intent.intent === 'ask') {
      return this.executeIntent(taskId, trimmed, state, intent);
    }

    if (intent.requiresClarification || intent.confidence < 0.6) {
      return {
        kind: 'reply',
        auditAction: `intent:${intent.intent}:clarify`,
        auditMetadata: intentAuditMetadata(intent),
        messages: [await this.composeMessage({
          rawMessage: [
            intent.userFacingInterpretation || CLARIFY_INTENT_MESSAGE,
            `为了不误推进 workflow，请你再明确说一次。当前可以：${formatAllowedActions(allowedActions)}`,
          ].join('\n'),
          state,
        })],
      };
    }

    return this.executeIntent(taskId, trimmed, state, intent);
  }

  private async executeExplicitWorkflowCommand(
    taskId: string,
    state: TaskState,
    explicitCommand: ExplicitWorkflowCommand,
  ): Promise<ConversationTurn> {
    const allowedActions = getAllowedActions(state);
    const allowed = allowedActions.some((action) => action.id === explicitCommand.intent);
    if (!allowed) {
      return {
        kind: 'reply',
        auditAction: `intent:${explicitCommand.intent}:blocked`,
        auditMetadata: { intent: explicitCommand.intent },
        messages: [await this.composeMessage({
          rawMessage: [
            `收到 ${explicitCommand.intent} 指令，但当前阶段还不能执行这个动作。`,
            `当前阶段是「${humanStageName(state.status)}」。`,
            `现在可以：${formatAllowedActions(allowedActions)}`,
          ].join('\n'),
          state,
        })],
      };
    }
    if (explicitCommand.intent === 'status' || explicitCommand.intent === 'summary') {
      const result = await this.workflow.reply(taskId, explicitCommand.reply);
      return {
        kind: 'reply',
        auditAction: `intent:${explicitCommand.intent}`,
        auditMetadata: { intent: explicitCommand.intent },
        messages: [await this.composeWorkflowResult(result)],
      };
    }
    return {
      kind: 'background',
      auditAction: `intent:${explicitCommand.intent}`,
      auditMetadata: { intent: explicitCommand.intent, ...(explicitCommand.instruction ? { instruction: explicitCommand.instruction } : {}) },
      startedMessage: { text: renderExplicitCommandStartedMessage(explicitCommand) },
      run: () => this.workflow.reply(taskId, explicitCommand.reply),
    };
  }

  private async orchestratorTurnToConversationTurn(turn: OrchestratorTurn): Promise<ConversationTurn> {
    if (turn.kind === 'reply') {
      return {
        kind: 'reply',
        ...(turn.auditAction ? { auditAction: turn.auditAction } : {}),
        ...(turn.auditMetadata ? { auditMetadata: turn.auditMetadata } : {}),
        messages: [await this.composeMessage({
          rawMessage: turn.rawMessage,
          state: turn.state,
          ...(turn.files ? { files: turn.files } : {}),
        })],
      };
    }
    return {
      kind: 'background',
      ...(turn.auditAction ? { auditAction: turn.auditAction } : {}),
      ...(turn.auditMetadata ? { auditMetadata: turn.auditMetadata } : {}),
      startedMessage: await this.composeMessage({
        rawMessage: turn.startedMessage,
        state: turn.state,
        includePendingPrompt: false,
      }),
      run: turn.run,
    };
  }

  async notifyForState(taskId: string): Promise<OutboundMessage> {
    return this.composeStateNotification(await this.store.loadState(taskId));
  }

  async composeWorkflowResult(result: WorkflowResult, userQuestion?: string): Promise<OutboundMessage> {
    const files = filesForState(result.state);
    return this.composeMessage({
      rawMessage: result.message,
      state: result.state,
      ...(userQuestion ? { userQuestion } : {}),
      ...(files ? { files } : {}),
    });
  }

  async composeStateNotification(state: TaskState): Promise<OutboundMessage> {
    const files = filesForState(state);
    return this.composeMessage({
      rawMessage: renderStateNotificationText(state),
      state,
      ...(files ? { files } : {}),
    });
  }

  async routeControlMessage(text: string, pendingProposal?: TaskProposal, projectId?: string): Promise<ControlConversationTurn> {
    const result = await this.runControlChat(text, pendingProposal, 'message', projectId);
    return controlResultToTurn(result);
  }

  async reviseControlProposal(instruction: string, pendingProposal: TaskProposal, projectId?: string): Promise<ControlConversationTurn> {
    const result = await this.runControlChat(instruction, pendingProposal, 'edit', projectId);
    return controlResultToTurn(result);
  }

  private async classifyTaskIntent(message: string, state: TaskState): Promise<{ intent: IntentResult } | { turn: ConversationTurn }> {
    if (!this.assistant || !this.config) {
      return {
        turn: {
          kind: 'reply',
          auditAction: 'intent:missing_manager',
        messages: [{ text: '当前没有配置 VibeCodingAssistant-ElonMa 对话分类器，所以我没有推进 workflow。' }],
        },
      };
    }

    const allowedActions = getAllowedActions(state);
    try {
      const recentContext = await this.buildTaskChatContext(state);
      return {
      intent: await this.assistant.classifyIntent({
          userMessage: message,
          state,
          allowedActions,
          recentContext,
          config: this.config,
        }),
      };
    } catch (error) {
      return {
        turn: {
          kind: 'reply',
          auditAction: 'intent:error',
          auditMetadata: { routeError: errorMessage(error) },
          messages: [await this.composeMessage({
            rawMessage: [
              '我收到你的消息了，但刚才调用意图分类失败，所以没有推进 workflow。',
              `当前阶段：${humanStageName(state.status)}`,
              state.pendingUserPrompt ? `现在等你处理：${state.pendingUserPrompt}` : undefined,
              `错误：${errorMessage(error)}`,
            ].filter(Boolean).join('\n'),
            state,
          })],
        },
      };
    }
  }

  private async executeIntent(
    taskId: string,
    originalMessage: string,
    state: TaskState,
    intent: IntentResult,
  ): Promise<ConversationTurn> {
    if (intent.intent === 'ask' && intent.artifact) {
      return {
        kind: 'reply',
        auditAction: `intent:ask:artifact:${intent.artifact}`,
        auditMetadata: intentAuditMetadata(intent),
        messages: [await this.renderArtifact(taskId, intent.artifact)],
      };
    }

    if (intent.intent === 'ask') {
      const result = await this.workflow.askQuestion(taskId, originalMessage);
      return {
        kind: 'reply',
        auditAction: 'intent:ask',
        auditMetadata: intentAuditMetadata(intent),
        messages: [await this.composeWorkflowResult(result, originalMessage)],
      };
    }

    if (intent.intent === 'status' || intent.intent === 'summary') {
      const result = await this.workflow.reply(taskId, intent.intent);
      return {
        kind: 'reply',
        auditAction: `intent:${intent.intent}`,
        auditMetadata: intentAuditMetadata(intent),
        messages: [await this.composeWorkflowResult(result)],
      };
    }

    const reply = workflowReplyForIntent(intent, originalMessage, state);
    if (!reply) {
      return {
        kind: 'reply',
        auditAction: `intent:${intent.intent}:clarify`,
        auditMetadata: intentAuditMetadata(intent),
        messages: [await this.composeMessage({
          rawMessage: '我理解你想继续推进，但缺少必要信息。比如选择难度时需要明确 low、medium、high 或 extra high。',
          state,
        })],
      };
    }

    return {
      kind: 'background',
      auditAction: `intent:${intent.intent}`,
      auditMetadata: intentAuditMetadata(intent),
      startedMessage: await this.composeMessage({
        rawMessage: [
          intent.userFacingInterpretation || `收到，我会按「${intent.intent}」处理。`,
          '这个动作已通过当前 workflow gate，我现在开始执行；跑完会把下一步发到这里。',
        ].join('\n'),
        state,
        includePendingPrompt: false,
      }),
      run: () => this.workflow.reply(taskId, reply),
    };
  }

  private async renderArtifact(taskId: string, artifact: ArtifactName): Promise<OutboundMessage> {
    const content = await this.workflow.showArtifact(taskId, artifact);
    const state = await this.store.loadState(taskId);
    const path = state.artifacts[artifact];
    return {
      text: [`${artifact}:`, '', shorten(content, 1200)].join('\n'),
      ...(path ? { files: [{ path, name: basename(path) }] } : {}),
    };
  }

  private async runControlChat(
    message: string,
    pendingProposal: TaskProposal | undefined,
    mode: 'message' | 'edit',
    projectId: string | undefined,
  ): Promise<ControlChatResult> {
    if (this.assistant && this.config) {
      const query = [
        message,
        pendingProposal?.title,
        pendingProposal?.interpretedIntent,
        pendingProposal?.task,
      ].filter(Boolean).join('\n\n');
      const projectContext = await this.projectKnowledge.buildContextPacket(this.config, {
        projectId: projectId ?? getDefaultProjectId(this.config),
        query,
      });
      return this.assistant.handleControlChat({
        message,
        mode,
        config: this.config,
        projectContext,
        ...(pendingProposal ? { pendingProposal } : {}),
      });
    }
    return fallbackControlChat(message, pendingProposal, mode);
  }

  private async buildTaskChatContext(state: TaskState): Promise<string> {
    const context: string[] = [
      `State:\n${JSON.stringify({ ...state, artifacts: undefined }, null, 2)}`,
    ];
    for (const name of TASK_CONTEXT_ARTIFACT_NAMES) {
      if (!state.artifacts[name]) continue;
      const content = await this.store.readArtifact(state, name).catch(() => '');
      if (content.trim()) context.push(`## ${name}\n${shorten(content, 3000)}`);
    }
    return context.join('\n\n');
  }

  private async composeMessage(input: {
    rawMessage: string;
    state: TaskState;
    pendingPrompt?: string;
    userQuestion?: string;
    files?: OutboundFile[];
    includePendingPrompt?: boolean;
  }): Promise<OutboundMessage> {
    const fallback = fallbackComposeReply(input.rawMessage, input.state, input.pendingPrompt, input.includePendingPrompt);
    if (!this.assistant || !this.config) {
      return { text: fallback, ...(input.files ? { files: input.files } : {}) };
    }
    try {
      const pendingPrompt = input.includePendingPrompt === false
        ? undefined
        : input.pendingPrompt ?? input.state.pendingUserPrompt;
    const composed = await this.assistant.composeReply({
        rawMessage: input.rawMessage,
        state: input.state,
        ...(pendingPrompt ? { pendingPrompt } : {}),
        ...(input.userQuestion ? { userQuestion: input.userQuestion } : {}),
        config: this.config,
      });
      const text = sanitizeUserFacingText(composed.text.trim()) || fallback;
      return { text, ...(input.files ? { files: input.files } : {}) };
    } catch {
      return { text: fallback, ...(input.files ? { files: input.files } : {}) };
    }
  }
}

export function parseExplicitTaskRequest(text: string): TaskRequest | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const slashCreate = trimmed.match(/^\/create\b([\s\S]*)$/i);
  const colonPrefix = trimmed.match(/^(?:create\s+task|new\s+task)\s*:\s*([\s\S]+)$/i);
  const body = slashCreate ? slashCreate[1]?.trim() ?? '' : colonPrefix?.[1]?.trim() ?? '';
  if (!body) return undefined;

  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstLine = lines[0] ?? 'Assistant task';
  const title = makeTitle(firstLine);
  const task = slashCreate && lines.length > 1 ? body.slice(body.indexOf(firstLine) + firstLine.length).trim() : body;

  return { title, task: task || body };
}

export function parseDirectPromptTaskRequest(text: string): TaskRequest | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return undefined;
  if (parseGlobalCommand(trimmed)) return undefined;
  if (/^(?:create\s+task|new\s+task|confirm|yes\s+create)$/i.test(trimmed)) return undefined;
  if (looksLikePromptGeneration(trimmed) && !/^(?:task|prompt)\s*:/i.test(trimmed)) return undefined;

  const taskLike = (
    /\r?\n/.test(trimmed) ||
    trimmed.length >= 80 ||
    /^(?:task|prompt|goal|problem)\s*:/i.test(trimmed) ||
    /^(?:帮我|请|实现|检查|修复|重构|implement\b|fix\b|build\b|redesign\b|create\b|add\b|update\b|refactor\b)/i.test(trimmed)
  );
  if (!taskLike) return undefined;

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstLine = lines[0] ?? 'Assistant task';
  const titleSource = firstLine.replace(/^(?:task|prompt|goal|problem)\s*:\s*/i, '').trim()
    || lines[1]
      || 'Assistant task';
  return { title: makeTitle(titleSource), task: trimmed };
}

export function parseTaskRequest(text: string): TaskRequest | undefined {
  return parseExplicitTaskRequest(text) ?? parseDirectPromptTaskRequest(text);
}

export function filesForState(state: TaskState): OutboundFile[] | undefined {
  const names = artifactsForState(state);
  const files = names
    .map((name) => state.artifacts[name])
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .map((path) => ({ path, name: basename(path) }));
  return files.length > 0 ? files : undefined;
}

function artifactsForState(state: TaskState): ArtifactName[] {
  if (state.status === 'ready_for_decision') return ['assistant-explanation', 'revised-plan'];
  if (state.status === 'waiting_user_direction' && state.pendingUserDecision?.source === 'extra_high_planning') {
    return ['revised-plan', 'plan-rounds-log'];
  }
  if (state.status === 'awaiting_user_acceptance') return ['final-review', 'test-build-log'];
  if (state.status === 'completed') return ['final-report'];
  return [];
}

function parseShowArtifact(text: string): ArtifactName | undefined {
  const match = text.match(/^\/show\s+([a-z-]+)\s*$/i);
  const artifact = match?.[1];
  return ARTIFACT_NAMES.includes(artifact as ArtifactName) ? artifact as ArtifactName : undefined;
}

export interface ExplicitWorkflowCommand {
  intent: IntentResult['intent'];
  reply: string;
  instruction?: string;
}

export function parseExplicitWorkflowCommand(text: string, state: TaskState): ExplicitWorkflowCommand | undefined {
  const compact = text.trim().replace(/\s+/g, ' ');
  if (!compact) return undefined;
  if (/^status$/i.test(compact)) return { intent: 'status', reply: 'status' };
  if (/^summary$/i.test(compact)) return { intent: 'summary', reply: 'summary' };
  if (isStopCommand(compact)) return { intent: 'stop', reply: 'stop' };

  const acceptMatch = compact.match(/^(?:accept|accepted)(?:\s*:\s*(.+))?$/i);
  if (acceptMatch) return { intent: 'accept', reply: compact, ...(acceptMatch[1]?.trim() ? { instruction: acceptMatch[1].trim() } : {}) };

  const difficultyMatch = compact.match(/^(low|medium|high|extra[-_ ]?high)(?:\s*:\s*(.+))?$/i);
  if (difficultyMatch?.[1]) {
    const difficulty = normalizeWorkflowDifficulty(difficultyMatch[1]);
    if (!difficulty) return undefined;
    return {
      intent: 'difficulty',
      reply: difficultyMatch[2]?.trim() ? `${difficulty}: ${difficultyMatch[2].trim()}` : difficulty,
      ...(difficultyMatch[2]?.trim() ? { instruction: difficultyMatch[2].trim() } : {}),
    };
  }

  const approveMatch = compact.match(/^(?:approve A|approve|approved|A|yes|y)(?:\s*:\s*(.+))?$/i);
  if (approveMatch) {
    const intent = state.status === 'awaiting_user_acceptance' ? 'accept' : 'approve';
    return { intent, reply: compact, ...(approveMatch[1]?.trim() ? { instruction: approveMatch[1].trim() } : {}) };
  }

  if (/^(?:reject B|reject|B|no|n)$/i.test(compact)) return { intent: 'reject', reply: compact };

  const noteMatch = compact.match(/^note\s*:\s*(.+)$/i);
  if (noteMatch?.[1]?.trim()) return { intent: 'note', reply: compact, instruction: noteMatch[1].trim() };

  const reviseMatch = compact.match(/^(?:revise\s+c|revise|c)\s*:\s*(.+)$/i);
  if (reviseMatch?.[1]?.trim()) return { intent: 'revise', reply: compact, instruction: reviseMatch[1].trim() };

  const match = text.match(/^(?:restart|redesign|rerun|start over|重新开始|重跑|从头跑|重新规划|重新设计|重启)\s*[:：]\s*([\s\S]+)$/i);
  const instruction = match?.[1]?.trim();
  return instruction ? { intent: 'restart', instruction, reply: `restart: ${instruction}` } : undefined;
}

export function parseGlobalCommand(text: string): GlobalCommand | undefined {
  const normalized = text.trim().replace(/^\//, '').toLocaleLowerCase();
  if (normalized === 'status' || normalized === 'summary' || normalized === 'help') {
    return normalized;
  }
  if (isStopCommand(normalized)) return 'stop';
  return undefined;
}

export function isStopCommand(text: string): boolean {
  const compact = text.trim().replace(/^\//, '').replace(/\s+/g, ' ').toLocaleLowerCase();
  const noSpaces = compact.replace(/\s+/g, '');
  if (/^(?:do not|don't|dont)\s+(?:stop|cancel|abort)\b/i.test(compact)) return false;
  if (/^(?:不要|别|別).*(?:取消|停止|中止|终止)/.test(noSpaces)) return false;
  return /^(?:stop|cancel|abort|cancel task|cancel this task|stop task|stop this task)$/i.test(compact)
    || /^(?:please\s+)?(?:cancel|abort|stop)(?:\s+(?:this|the|current))?(?:\s+(?:task|workflow|job))?$/i.test(compact)
    || /^(?:(?:i\s+(?:want|wanna|need)\s+to)|please|can you|could you|help me)\s+(?:cancel|abort|stop)\b/i.test(compact)
    || /^(?:取消|取消task|取消任务|停止|停止task|停止任务|中止|中止任务|终止|终止任务|结束任务|别做了|別做了|不做了|先别做了|先別做了)$/.test(noSpaces)
    || /^(?:我想|我要|帮我|请|麻烦)?(?:取消|停止|中止|终止|结束)(?:这个|当前|这条|该)?(?:task|任务|workflow|流程)?$/.test(noSpaces)
    || /(?:取消|停止|中止|终止|结束)(?:这个|当前|这条|该)?(?:task|任务|workflow|流程)/.test(noSpaces)
    || /^(?:别|別|先别|先別)(?:再)?(?:做|跑|执行|继续|繼續)(?:了|这个|这个任务|这任务|task)?$/.test(noSpaces);
}

export function looksTaskLikeRequest(text: string): boolean {
  return /^(?:帮我|请|实现|检查|修复|implement\b|fix\b|build\b)/i.test(text.trim());
}

export function looksLikePromptGeneration(text: string): boolean {
  return /(?:prompt|提示词|整理一个|先不要创建\s*task|不要创建\s*task|不要执行|先帮我整理)/i.test(text.trim());
}

export function renderTaskProposal(proposal: TaskProposal): string {
  return [
    '我把它整理成了一份任务草案：',
    '',
    `理解到的意图：${localizeKnownProposalText(proposal.interpretedIntent)}`,
    `标题：${localizeKnownProposalText(proposal.title)}`,
    '',
    '建议任务内容：',
    localizeKnownProposalText(proposal.task),
    '',
    '会做：',
    ...proposal.wouldDo.map((item) => `- ${localizeKnownProposalText(item)}`),
    '',
    '不会做：',
    ...proposal.wouldNotDo.map((item) => `- ${localizeKnownProposalText(item)}`),
    '',
    `下一步：${localizeKnownProposalText(proposal.suggestedNextAction)}`,
    '',
    '要我按这份草案创建任务的话，直接说「创建任务」。也可以继续补充要改的地方。',
  ].join('\n');
}

export function stripMentions(text: string): string {
  return text.replace(/@_user_\d+|<at[^>]*>.*?<\/at>|@\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

function controlResultToTurn(result: ControlChatResult): ControlConversationTurn {
  if (result.kind === 'proposal') {
    return {
      kind: 'proposal',
      proposal: result.proposal,
      message: { text: renderTaskProposal(result.proposal) },
    };
  }
  if (result.kind === 'confirm_pending_proposal') {
    return {
      kind: 'confirm_pending_proposal',
      ...(result.markdown ? { message: { text: result.markdown } } : {}),
    };
  }
  if (result.kind === 'cancel_pending_proposal') {
    return {
      kind: 'cancel_pending_proposal',
      ...(result.markdown ? { message: { text: result.markdown } } : {}),
    };
  }
  return { kind: 'reply', message: { text: result.markdown } };
}

function fallbackControlChat(
  message: string,
  pendingProposal: TaskProposal | undefined,
  mode: 'message' | 'edit',
): ControlChatResult {
  const trimmed = message.trim();
  if (mode === 'edit' && pendingProposal) {
    const task = `${pendingProposal.task}\n\n修改要求：\n${trimmed}`;
    return {
      kind: 'proposal',
      proposal: {
        ...pendingProposal,
        task,
        suggestedNextAction: '可以说「创建任务」确认，或继续补充修改。',
      },
    };
  }
  if (looksLikePromptGeneration(trimmed)) {
    return {
      kind: 'answer',
      markdown: [
        '我先把它当作 prompt 草稿整理给你，不会创建任务：',
        '',
        trimmed,
        '',
        '目前没有创建任务。',
      ].join('\n'),
    };
  }
  if (looksTaskLikeRequest(trimmed)) {
    return {
      kind: 'proposal',
      proposal: {
      interpretedIntent: `把这条请求整理成一个可能的 assistant workflow 任务：${shorten(trimmed, 120)}`,
        title: makeTitle(trimmed),
        task: trimmed,
      wouldDo: ['在你确认后，把这段内容创建成一个 assistant workflow 任务。'],
        wouldNotDo: ['不会在你确认前启动规划、实现或 agent 调用。'],
        suggestedNextAction: '可以说「创建任务」确认，或继续补充修改。',
      },
    };
  }
  return {
    kind: 'answer',
    markdown: [
      '我可以继续帮你梳理。',
      '',
      trimmed,
      '',
      '目前没有创建任务。如果要直接创建任务，可以用命令：create task: <任务内容>。',
    ].join('\n'),
  };
}

function localizeKnownProposalText(text: string): string {
  const trimmed = text.trim();
  if (/^Use the suggested task prompt as the workflow input\.?$/i.test(trimmed)) {
    return '在你确认后，把建议的任务内容作为 workflow 输入。';
  }
  if (/^Start implementation before you confirm task creation\.?$/i.test(trimmed)) {
    return '不会在你确认前启动实现。';
  }
  if (/^Create a workflow task after confirmation\.?$/i.test(trimmed)) {
    return '在你确认后创建 workflow 任务。';
  }
  if (/^Start the workflow before confirmation\.?$/i.test(trimmed)) {
    return '不会在你确认前启动 workflow。';
  }
  if (/^Reply create task, edit: <instruction>, or cancel\.?$/i.test(trimmed)) {
    return '可以说「创建任务」确认，或继续补充修改。';
  }
  return text
    .replace(/^Turn this request into a possible assistant workflow task:\s*/i, '把这条请求整理成一个可能的 assistant workflow 任务：')
    .replace(/^intent:\s*/i, '理解为：')
    .replace(/^Task prompt:\s*/i, '')
    .replace(/\n\nRevision request:\n/gi, '\n\n修改要求：\n');
}

function normalizeIntentForState(intent: IntentResult, state: TaskState): IntentResult {
  if (state.status === 'awaiting_user_acceptance' && intent.intent === 'approve') {
    return { ...intent, intent: 'accept' };
  }
  return intent;
}

function conversationalFallbackIntent(
  message: string,
  intent: IntentResult,
  allowedActions: AllowedAction[],
): IntentResult | undefined {
  if (intent.intent !== 'unknown') return undefined;
  if (!allowedActions.some((action) => action.id === 'ask')) return undefined;
  if (!looksConversational(message)) return undefined;
  return {
    ...intent,
    intent: 'ask',
    confidence: Math.max(intent.confidence, 0.6),
    requiresClarification: false,
    userFacingInterpretation: intent.userFacingInterpretation || '我把这当成你在和我讨论当前任务。',
  };
}

function looksConversational(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (/^[abcyn]$/i.test(trimmed)) return false;
  if (/^(?:yes|no|ok|okay)$/i.test(trimmed)) return false;
  return trimmed.length >= 2;
}

function workflowReplyForIntent(intent: IntentResult, originalMessage: string, state: TaskState): string | undefined {
  switch (intent.intent) {
    case 'approve':
      if (state.status === 'awaiting_user_acceptance') return instructionReply('accept', intent.instruction);
      return instructionReply('approve A', intent.instruction);
    case 'reject':
      return 'reject B';
    case 'revise':
      return `revise C: ${intent.instruction ?? originalMessage}`;
    case 'difficulty':
      return intent.difficulty ? instructionReply(intent.difficulty, intent.instruction) : undefined;
    case 'stop':
      return 'stop';
    case 'accept':
      return 'accept';
    case 'note':
      return `note: ${intent.note ?? originalMessage}`;
    case 'restart':
      return `restart: ${intent.instruction ?? originalMessage}`;
    case 'status':
    case 'summary':
    case 'ask':
    case 'unknown':
      return undefined;
  }
}

function renderExplicitCommandStartedMessage(command: ExplicitWorkflowCommand): string {
  if (command.intent === 'difficulty') {
    return `收到 ${command.reply}，开始规划。跑完我会把计划和下一步发到这里；不用重复发送难度。`;
  }
  if (command.intent === 'approve') {
    return '收到批准，开始执行。跑完我会把结果发到这里。';
  }
  if (command.intent === 'accept') {
    return '收到验收通过，开始生成 task-record。跑完我会发最终结果。';
  }
  if (command.intent === 'revise' || command.intent === 'restart') {
    return '收到修改要求，开始重新规划。跑完我会把新计划发到这里。';
  }
  return `收到 ${command.intent} 指令，开始处理。跑完我会把下一步发到这里。`;
}

function intentAuditMetadata(intent: IntentResult): Record<string, unknown> {
  return {
    intent: intent.intent,
    confidence: intent.confidence,
    requiresClarification: intent.requiresClarification,
    userFacingInterpretation: intent.userFacingInterpretation,
    ...(intent.difficulty ? { difficulty: intent.difficulty } : {}),
    ...(intent.instruction ? { instruction: intent.instruction } : {}),
    ...(intent.note ? { note: intent.note } : {}),
    ...(intent.artifact ? { artifact: intent.artifact } : {}),
  };
}

function instructionReply(base: string, instruction?: string): string {
  return instruction ? `${base}: ${instruction}` : base;
}

function formatAllowedActions(actions: AllowedAction[]): string {
  return actions.map((action) => action.description).join('；');
}

function renderStateNotificationText(state: TaskState): string {
  return [
    `现在是「${humanStageName(state.status)}」。`,
    state.pendingUserPrompt ? `等你处理：${localizePendingPrompt(state.pendingUserPrompt)}` : undefined,
  ].filter(Boolean).join('\n');
}

function fallbackComposeReply(
  rawMessage: string,
  state: TaskState,
  pendingPrompt?: string,
  includePendingPrompt = true,
): string {
  const prompt = includePendingPrompt ? pendingPrompt ?? state.pendingUserPrompt : undefined;
  const cleaned = sanitizeUserFacingText(rawMessage);
  const notificationState = includePendingPrompt ? state : stateWithoutPendingPrompt(state);
  const base = isWorkflowBoilerplate(rawMessage) || !cleaned
    ? renderStateNotificationText(notificationState)
    : cleaned;
  return [
    base,
    prompt && !base.includes(localizePendingPrompt(prompt)) ? `现在需要你处理：${localizePendingPrompt(prompt)}` : undefined,
  ].filter(Boolean).join('\n');
}

function stateWithoutPendingPrompt(state: TaskState): TaskState {
  const copy = { ...state };
  delete copy.pendingUserPrompt;
  delete copy.pendingUserDecision;
  return copy;
}

function sanitizeUserFacingText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^(?:Task|Task ID|Title|Status|Category|Execution mode|Difficulty|Revision round|Reviewer runs|Pending|Pending user prompt):\s*/i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isWorkflowBoilerplate(text: string): boolean {
  const trimmed = text.trim();
  if (/^(?:Task|Task ID|Status|Pending):\s*/im.test(trimmed)) return true;
  return /^(?:Revised plan is ready|Final review passed|Task accepted|Task stopped|Choose workflow difficulty|Plan revision limit reached|Revised plan rejected)/i.test(trimmed);
}

function localizePendingPrompt(prompt: string): string {
  if (/Choose workflow difficulty/i.test(prompt)) {
    return '请选择难度：低/中/高/extra high。也可以直接说「默认难度」或「高难度」。';
  }
  if (/Approve A to implement/i.test(prompt) || /ready for your decision/i.test(prompt)) {
    return '请确认修订后的计划：可以说「批准/开始实现」，或说明还要改哪里。';
  }
  if (/Final review passed/i.test(prompt) || /Reply accept to finalize/i.test(prompt)) {
    return '等你验收：可以说「验收通过」生成 task-record，也可以补充备注或要求修改。';
  }
  return prompt;
}

function makeTitle(text: string): string {
  return shorten(text.replace(/^#+\s*/, '').trim() || 'Assistant task', 80);
}

function shorten(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
