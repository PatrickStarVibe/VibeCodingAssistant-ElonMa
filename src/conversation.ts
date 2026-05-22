import { basename } from 'node:path';

import { ArtifactStore } from './artifacts.js';
import type { ManagerAdapter } from './adapters.js';
import { getAllowedActions, humanStageName } from './allowedActions.js';
import { ProjectKnowledgeService } from './projectKnowledge.js';
import { getDefaultProjectId } from './projects.js';
import type {
  AllowedAction,
  ArtifactName,
  ControlChatResult,
  IntentResult,
  ManagerConfig,
  TaskProposal,
  TaskState,
} from './types.js';
import type { WorkflowResult, WorkflowService } from './workflow.js';

const ARTIFACT_NAMES: ArtifactName[] = [
  'original-task',
  'manager-brief',
  'initial-plan',
  'review',
  'revision-instructions',
  'revised-plan',
  'manager-explanation',
  'qa-log',
  'decision-log',
  'implementation-log',
  'git-pre-status',
  'git-post-status',
  'git-pre-diff',
  'git-post-diff',
  'test-build-log',
  'final-review',
  'final-report',
];

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
  | { kind: 'proposal'; message: OutboundMessage; proposal: TaskProposal };

export class ManagerConversationService {
  private readonly projectKnowledge: ProjectKnowledgeService;

  constructor(
    private readonly workflow: WorkflowService,
    private readonly store: ArtifactStore,
    private readonly manager?: ManagerAdapter,
    private readonly config?: ManagerConfig,
  ) {
    this.projectKnowledge = new ProjectKnowledgeService(store.managerRoot);
  }

  async createTask(input: TaskRequest): Promise<WorkflowResult> {
    return this.workflow.createTask(input);
  }

  startBrief(taskId: string): BackgroundConversationTurn {
    return {
      kind: 'background',
      startedMessage: { text: '任务已创建，我开始整理 brief。跑完会把需要你确认的内容发到这里。' },
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
    const classified = await this.classifyTaskIntent(trimmed, state);
    if ('turn' in classified) return classified.turn;

    const intent = normalizeIntentForState(classified.intent, state);
    const allowedActions = getAllowedActions(state);
    const allowed = allowedActions.some((action) => action.id === intent.intent);
    if (!allowed) {
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
    if (!this.manager || !this.config) {
      return {
        turn: {
          kind: 'reply',
          auditAction: 'intent:missing_manager',
          messages: [{ text: '当前没有配置 Manager 对话分类器，所以我没有推进 workflow。' }],
        },
      };
    }

    const allowedActions = getAllowedActions(state);
    try {
      const recentContext = await this.buildTaskChatContext(state);
      return {
        intent: await this.manager.classifyIntent({
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
          rawMessage: '我理解你想继续推进，但缺少必要信息。比如选择难度时需要明确 low、medium 或 high。',
          state,
        })],
      };
    }

    return {
      kind: 'background',
      auditAction: `intent:${intent.intent}`,
      auditMetadata: intentAuditMetadata(intent),
      startedMessage: {
        text: intent.userFacingInterpretation || `收到，我会按「${intent.intent}」处理。`,
      },
      run: () => this.workflow.reply(taskId, reply),
    };
  }

  private async renderArtifact(taskId: string, artifact: ArtifactName): Promise<OutboundMessage> {
    const state = await this.store.loadState(taskId);
    const content = await this.workflow.showArtifact(taskId, artifact);
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
    if (this.manager && this.config) {
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
      return this.manager.handleControlChat({
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
    for (const name of ARTIFACT_NAMES) {
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
  }): Promise<OutboundMessage> {
    const fallback = fallbackComposeReply(input.rawMessage, input.state, input.pendingPrompt);
    if (!this.manager || !this.config) {
      return { text: fallback, ...(input.files ? { files: input.files } : {}) };
    }
    try {
      const pendingPrompt = input.pendingPrompt ?? input.state.pendingUserPrompt;
      const composed = await this.manager.composeReply({
        rawMessage: input.rawMessage,
        state: input.state,
        ...(pendingPrompt ? { pendingPrompt } : {}),
        ...(input.userQuestion ? { userQuestion: input.userQuestion } : {}),
        config: this.config,
      });
      return { text: composed.text.trim() || fallback, ...(input.files ? { files: input.files } : {}) };
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
  const firstLine = lines[0] ?? 'Manager task';
  const title = makeTitle(firstLine);
  const task = slashCreate && lines.length > 1 ? body.slice(body.indexOf(firstLine) + firstLine.length).trim() : body;

  return { title, task: task || body };
}

export function parseTaskRequest(text: string): TaskRequest | undefined {
  return parseExplicitTaskRequest(text);
}

export function filesForState(state: TaskState): OutboundFile[] | undefined {
  const names = artifactsForStatus(state.status);
  const files = names
    .map((name) => state.artifacts[name])
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .map((path) => ({ path, name: basename(path) }));
  return files.length > 0 ? files : undefined;
}

function artifactsForStatus(status: TaskState['status']): ArtifactName[] {
  if (status === 'awaiting_brief_confirmation') return ['manager-brief'];
  if (status === 'ready_for_decision') return ['manager-explanation', 'revised-plan'];
  if (status === 'awaiting_user_acceptance') return ['final-review', 'test-build-log'];
  if (status === 'completed') return ['final-report'];
  return [];
}

function parseShowArtifact(text: string): ArtifactName | undefined {
  const match = text.match(/^\/show\s+([a-z-]+)\s*$/i);
  const artifact = match?.[1];
  return ARTIFACT_NAMES.includes(artifact as ArtifactName) ? artifact as ArtifactName : undefined;
}

export function parseGlobalCommand(text: string): GlobalCommand | undefined {
  const normalized = text.trim().replace(/^\//, '').toLocaleLowerCase();
  if (normalized === 'status' || normalized === 'summary' || normalized === 'help' || normalized === 'stop') {
    return normalized;
  }
  return undefined;
}

export function looksTaskLikeRequest(text: string): boolean {
  return /^(?:帮我|请|实现|检查|修复|implement\b|fix\b|build\b)/i.test(text.trim());
}

export function looksLikePromptGeneration(text: string): boolean {
  return /(?:prompt|提示词|整理一个|先不要创建\s*task|不要创建\s*task|不要执行|先帮我整理)/i.test(text.trim());
}

export function renderTaskProposal(proposal: TaskProposal): string {
  return [
    'I think this could become a Manager task proposal:',
    '',
    `Intent: ${proposal.interpretedIntent}`,
    `Title: ${proposal.title}`,
    '',
    'Suggested task prompt:',
    proposal.task,
    '',
    'Would do:',
    ...proposal.wouldDo.map((item) => `- ${item}`),
    '',
    'Would not do:',
    ...proposal.wouldNotDo.map((item) => `- ${item}`),
    '',
    `Suggested next action: ${proposal.suggestedNextAction}`,
    '',
    'Do you want me to create a task from this?',
    'Reply: create task, edit: <instruction>, or cancel.',
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
      message: { text: [result.markdown, renderTaskProposal(result.proposal)].filter(Boolean).join('\n\n') },
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
    const task = `${pendingProposal.task}\n\nRevision request:\n${trimmed}`;
    return {
      kind: 'proposal',
      proposal: {
        ...pendingProposal,
        task,
        suggestedNextAction: 'Reply create task, edit: <instruction>, or cancel.',
      },
    };
  }
  if (looksLikePromptGeneration(trimmed)) {
    return {
      kind: 'answer',
      markdown: [
        'Here is a prompt draft you can refine before creating any task:',
        '',
        trimmed,
        '',
        'No task has been created.',
      ].join('\n'),
    };
  }
  if (looksTaskLikeRequest(trimmed)) {
    return {
      kind: 'proposal',
      proposal: {
        interpretedIntent: `Turn this request into a possible Manager workflow task: ${shorten(trimmed, 120)}`,
        title: makeTitle(trimmed),
        task: trimmed,
        wouldDo: ['Create a Manager workflow task from this prompt after you confirm.'],
        wouldNotDo: ['Start planning, implementation, or agent calls before confirmation.'],
        suggestedNextAction: 'Reply create task, edit: <instruction>, or cancel.',
      },
    };
  }
  return {
    kind: 'answer',
    markdown: [
      'I can help think this through.',
      '',
      trimmed,
      '',
      'No task has been created. If you want one, say: create task: <task>.',
    ].join('\n'),
  };
}

function normalizeIntentForState(intent: IntentResult, state: TaskState): IntentResult {
  if (state.status === 'awaiting_user_acceptance' && intent.intent === 'approve') {
    return { ...intent, intent: 'accept' };
  }
  return intent;
}

function workflowReplyForIntent(intent: IntentResult, originalMessage: string, state: TaskState): string | undefined {
  switch (intent.intent) {
    case 'approve':
      return state.status === 'awaiting_user_acceptance' ? 'accept' : 'approve A';
    case 'reject':
      return 'reject B';
    case 'revise':
      return `revise C: ${intent.instruction ?? originalMessage}`;
    case 'difficulty':
      return intent.difficulty;
    case 'stop':
      return 'stop';
    case 'accept':
      return 'accept';
    case 'note':
      return `note: ${intent.note ?? originalMessage}`;
    case 'status':
    case 'summary':
    case 'ask':
    case 'unknown':
      return undefined;
  }
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
  };
}

function formatAllowedActions(actions: AllowedAction[]): string {
  return actions.map((action) => action.description).join('；');
}

function renderStateNotificationText(state: TaskState): string {
  return [
    `现在是「${humanStageName(state.status)}」。`,
    state.pendingUserPrompt ? `等你处理：${state.pendingUserPrompt}` : undefined,
  ].filter(Boolean).join('\n');
}

function fallbackComposeReply(rawMessage: string, state: TaskState, pendingPrompt?: string): string {
  const prompt = pendingPrompt ?? state.pendingUserPrompt;
  return [
    rawMessage,
    prompt ? `现在需要你处理：${prompt}` : undefined,
  ].filter(Boolean).join('\n');
}

function makeTitle(text: string): string {
  return shorten(text.replace(/^#+\s*/, '').trim() || 'Manager task', 80);
}

function shorten(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
