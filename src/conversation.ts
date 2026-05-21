import { basename } from 'node:path';

import { ArtifactStore } from './artifacts.js';
import type { ManagerAdapter } from './adapters.js';
import { parseDeterministicReply } from './replyParser.js';
import type { ArtifactName, ControlChatResult, ManagerConfig, TaskProposal, TaskState } from './types.js';
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

const QUESTION_PATTERNS = [
  /[?？]\s*$/,
  /^(?:why|what|how|where|when|can you|could you)\b/i,
  /(?:为什么|怎么|如何|哪里|哪儿|风险|解释|说明|讲讲|是什么意思)/,
  /(?:有什么区别|大概怎么写)/,
  /^(?:帮我|请)\s*(?:解释|说明|讲讲|分析|看一下)/,
];

export const CLARIFY_INTENT_MESSAGE = [
  "I'm not sure whether you want to create a new task or ask about the current one. Reply:",
  '- new: <task>',
  '- status',
  '- summary',
  '- ask: <question>',
  '',
  '我不确定你是想创建新任务，还是想继续问当前任务。请回复：',
  '- new: <任务>',
  '- status',
  '- summary',
  '- ask: <问题>',
].join('\n');

export const NO_TASK_TO_STOP_MESSAGE = [
  'There is no active task in this chat to stop.',
  '这个聊天里没有可停止的当前 task。',
].join('\n');

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
  | { kind: 'reply'; messages: OutboundMessage[] }
  | { kind: 'background'; startedMessage: OutboundMessage; run: () => Promise<WorkflowResult> };

export type BackgroundConversationTurn = Extract<ConversationTurn, { kind: 'background' }>;

export type ControlConversationTurn =
  | { kind: 'reply'; message: OutboundMessage }
  | { kind: 'proposal'; message: OutboundMessage; proposal: TaskProposal };

export class ManagerConversationService {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly store: ArtifactStore,
    private readonly manager?: ManagerAdapter,
    private readonly config?: ManagerConfig,
  ) {}

  async createTask(input: TaskRequest): Promise<WorkflowResult> {
    return this.workflow.createTask(input);
  }

  startBrief(taskId: string): BackgroundConversationTurn {
    return {
      kind: 'background',
      startedMessage: { text: '已创建 task，开始生成 brief。跑完我会在这个群里通知你。' },
      run: () => this.workflow.planTask(taskId),
    };
  }

  async routeTaskMessage(taskId: string, text: string): Promise<ConversationTurn> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { kind: 'reply', messages: [{ text: '我收到的是空消息。请直接说需求，或者回复 A / revise C: ... / status。' }] };
    }

    const command = parseGlobalCommand(trimmed);
    if (command === 'help') {
      return { kind: 'reply', messages: [{ text: renderTaskHelp() }] };
    }
    if (command === 'status' || command === 'summary') {
      const result = await this.workflow.reply(taskId, command);
      return { kind: 'reply', messages: [renderWorkflowResult(result)] };
    }
    if (command === 'stop') {
      return {
        kind: 'background',
        startedMessage: { text: 'Stopping the current task. / 正在停止当前 task。' },
        run: () => this.workflow.reply(taskId, 'stop'),
      };
    }

    const showArtifact = parseShowArtifact(trimmed);
    if (showArtifact) {
      return { kind: 'reply', messages: [await this.renderArtifact(taskId, showArtifact)] };
    }

    const askQuestion = parseAskQuestion(trimmed);
    if (askQuestion || looksLikeQuestion(trimmed)) {
      const result = await this.workflow.askQuestion(taskId, askQuestion ?? trimmed);
      return { kind: 'reply', messages: [renderWorkflowResult(result)] };
    }

    const state = await this.store.loadState(taskId);
    if (isSingleLetterDecision(trimmed) && !isAwaitingAbcDecision(state.status)) {
      return { kind: 'reply', messages: [{ text: CLARIFY_INTENT_MESSAGE }] };
    }

    const parsed = parseDeterministicReply(trimmed);
    if (parsed.kind === 'status' || parsed.kind === 'summary' || parsed.kind === 'ambiguous') {
      const result = await this.workflow.reply(taskId, trimmed);
      return { kind: 'reply', messages: [renderWorkflowResult(result)] };
    }

    return {
      kind: 'background',
      startedMessage: { text: `已收到：${shorten(trimmed, 80)}\n我开始处理，跑完通知你。` },
      run: () => this.workflow.reply(taskId, trimmed),
    };
  }

  async notifyForState(taskId: string): Promise<OutboundMessage> {
    const state = await this.store.loadState(taskId);
    return renderStateNotification(state);
  }

  async routeControlMessage(text: string, pendingProposal?: TaskProposal): Promise<ControlConversationTurn> {
    const result = await this.runControlChat(text, pendingProposal, 'message');
    return controlResultToTurn(result);
  }

  async reviseControlProposal(instruction: string, pendingProposal: TaskProposal): Promise<ControlConversationTurn> {
    const result = await this.runControlChat(instruction, pendingProposal, 'edit');
    return controlResultToTurn(result);
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
  ): Promise<ControlChatResult> {
    if (this.manager && this.config) {
      return this.manager.handleControlChat({
        message,
        mode,
        config: this.config,
        ...(pendingProposal ? { pendingProposal } : {}),
      });
    }
    return fallbackControlChat(message, pendingProposal, mode);
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

export function renderWorkflowResult(result: WorkflowResult): OutboundMessage {
  const files = filesForState(result.state);
  return {
    text: [
      result.message,
      '',
      `Task: ${result.state.title}`,
      `Task ID: ${result.state.taskId}`,
      `Status: ${result.state.status}`,
      result.state.pendingUserPrompt ? `Pending: ${result.state.pendingUserPrompt}` : undefined,
    ].filter(Boolean).join('\n'),
    ...(files ? { files } : {}),
  };
}

export function renderStateNotification(state: TaskState): OutboundMessage {
  const files = filesForState(state);
  const prompt = state.pendingUserPrompt ? `\n\n${state.pendingUserPrompt}` : '';
  return {
    text: [
      `Task: ${state.title}`,
      `Task ID: ${state.taskId}`,
      `Status: ${state.status}${prompt}`,
    ].join('\n'),
    ...(files ? { files } : {}),
  };
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
  if (status === 'completed') return ['final-report'];
  return [];
}

function parseAskQuestion(text: string): string | undefined {
  const match = text.match(/^(?:\/ask\b|ask\s*:)\s*([\s\S]*)$/i);
  const question = match?.[1]?.trim();
  return question || undefined;
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

export function looksLikeQuestion(text: string): boolean {
  return QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksTaskLikeRequest(text: string): boolean {
  return /^(?:帮我|请|实现|检查|修复)\S*/.test(text.trim());
}

export function looksLikePromptGeneration(text: string): boolean {
  return /(?:prompt|提示词|整理一下|先不要创建\s*task|不要创建\s*task|不要执行|先帮我整理)/i.test(text.trim());
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

function isSingleLetterDecision(text: string): boolean {
  return /^[abc]$/i.test(text.trim());
}

function isAwaitingAbcDecision(status: TaskState['status']): boolean {
  return status === 'awaiting_brief_confirmation' || status === 'ready_for_decision' || status === 'waiting_user_direction';
}

function renderTaskHelp(): string {
  return [
    'Current task commands:',
    '- status: show this task status',
    '- summary: summarize this task',
    '- ask: <question>: ask about this task',
    '- /show <artifact>: show a task artifact',
    '- approve A / reject B / revise C: <instruction>: make a decision when requested',
    '- stop: stop this task',
    '- create task: <task>: create a separate new task',
    '- /create <task>: create a separate new task',
    '- new task: <task>: create a separate new task',
    '',
    '当前 task 可用命令：',
    '- status：查看当前 task 状态',
    '- summary：总结当前 task',
    '- ask: <问题>：询问当前 task',
    '- /show <artifact>：查看 task artifact',
    '- approve A / reject B / revise C: <说明>：在需要决策时回复',
    '- stop：停止当前 task',
    '- create task: <任务>：创建一个新的独立 task',
    '- /create <任务>：创建一个新的独立 task',
    '- new task: <任务>：创建一个新的独立 task',
  ].join('\n');
}

function makeTitle(text: string): string {
  return shorten(text.replace(/^#+\s*/, '').trim() || 'Manager task', 80);
}

function shorten(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}
