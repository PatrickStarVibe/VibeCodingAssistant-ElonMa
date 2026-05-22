import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ArtifactStore } from './artifacts.js';
import {
  ManagerConversationService,
  NO_TASK_TO_STOP_MESSAGE,
  parseExplicitTaskRequest,
  parseGlobalCommand,
  renderTaskProposal,
  type OutboundMessage,
} from './conversation.js';
import { humanStageName } from './allowedActions.js';
import type { ManagerConfig, TaskProposal, TaskState } from './types.js';
import { findProject, getDefaultProjectId, renderProjectList, requireProject } from './projects.js';
import type { WorkflowResult } from './workflow.js';
import {
  addPairedOpenId,
  isAuthorizedOpenId,
  rememberEvent,
  type LarkPendingTaskProposal,
  type LarkBridgeState,
  LarkBridgeStateStore,
} from './larkBridgeState.js';

export interface LarkIncomingMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  senderOpenId: string;
  text: string;
}

export interface LarkClientPort {
  start(onMessage: (message: LarkIncomingMessage) => void | Promise<void>): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, file: { path: string; name: string }): Promise<void>;
  createTaskChat(input: { name: string; memberOpenIds: string[] }): Promise<string>;
}

export class LarkBridge {
  private readonly conversation: ManagerConversationService;
  private readonly stateStore: LarkBridgeStateStore;
  private state: LarkBridgeState | undefined;
  private watcher: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: ManagerConfig,
    private readonly artifactStore: ArtifactStore,
    private readonly client: LarkClientPort,
    conversation: ManagerConversationService,
    stateStore: LarkBridgeStateStore,
  ) {
    this.conversation = conversation;
    this.stateStore = stateStore;
  }

  async start(): Promise<void> {
    this.state = await this.stateStore.load();
    console.log(`Lark pairing code: ${this.state.pairingCode}`);
    console.log('Send /pair <code> to the bot from your Lark account before creating tasks.');
    await this.client.start((message) => {
      void this.handleMessage(message).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
      });
    });
    this.watcher = setInterval(() => {
      void this.watchTaskStatuses().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
      });
    }, Math.max(1, this.config.lark.watchIntervalSeconds) * 1000);
  }

  stop(): void {
    if (this.watcher) clearInterval(this.watcher);
  }

  async handleMessage(message: LarkIncomingMessage): Promise<void> {
    const state = await this.loadState();
    const initialBinding = state.bindingsByChatId[message.chatId];
    await this.auditInbound(message, {
      ...(initialBinding ? { boundTaskId: initialBinding.taskId } : {}),
      outcome: 'received',
    });
    if (state.processedEventIds.includes(message.eventId)) {
      await this.auditInbound(message, {
        ...(initialBinding ? { boundTaskId: initialBinding.taskId } : {}),
        outcome: 'duplicate_ignored',
      });
      return;
    }
    await this.saveState(rememberEvent(state, message.eventId));

    if (await this.handlePairing(message)) return;

    const current = await this.loadState();
    if (!isAuthorizedOpenId(current, this.config, message.senderOpenId)) {
      console.log(`Ignored unauthorized Lark sender ${message.senderOpenId}.`);
      await this.auditInbound(message, { outcome: 'unauthorized_ignored' });
      return;
    }

    const binding = current.bindingsByChatId[message.chatId];
    const projectCommand = parseProjectCommand(message.text);
    if (projectCommand) {
      await this.auditInbound(message, {
        ...(binding ? { boundTaskId: binding.taskId } : {}),
        action: `project:${projectCommand.kind}`,
        outcome: 'project_command',
      });
      await this.handleProjectCommand(message, projectCommand, binding?.taskId);
      return;
    }

    if (binding) {
      await this.auditInbound(message, { boundTaskId: binding.taskId, outcome: 'task_chat' });
      await this.handleTaskChatMessage(message, binding.taskId);
      return;
    }

    const pendingProposal = current.pendingProposalsByChatId[message.chatId];
    const command = parseGlobalCommand(message.text);
    if (command) {
      await this.auditInbound(message, { action: command, outcome: 'unbound_command' });
      await this.handleUnboundCommand(message.chatId, command, pendingProposal);
      return;
    }

    if (!this.canCreateTaskFromChat(message.chatId)) {
      await this.sendText(message.chatId, '这个聊天没有绑定 task，也不在允许创建 task 的控制群里。', { action: 'unbound_rejected' });
      return;
    }

    const directTaskRequest = parseExplicitTaskRequest(message.text);
    if (directTaskRequest) {
      const state = await this.loadState();
      delete state.pendingProposalsByChatId[message.chatId];
      await this.saveState(state);
      await this.auditInbound(message, { action: 'create_new_task', outcome: 'direct_task_request' });
      await this.createTaskFromMessage(message, directTaskRequest);
      return;
    }

    await this.auditInbound(message, { action: 'control_chat', outcome: 'control_chat' });
    await this.handleControlChatMessage(message, pendingProposal, current.activeProjectIdByChatId[message.chatId]);
  }

  async watchTaskStatuses(): Promise<void> {
    const state = await this.loadState();
    const now = new Date();
    for (const [chatId, binding] of Object.entries(state.bindingsByChatId)) {
      const taskState = await this.artifactStore.loadState(binding.taskId).catch(() => undefined);
      if (!taskState) continue;
      const running = state.runningJobsByTaskId[binding.taskId];
      if (running && shouldSendRunningReminder(running.lastNotifiedAt ?? running.startedAt, now)) {
        await this.sendText(chatId, renderRunningReminder(taskState, running, now), { taskId: binding.taskId, action: 'running_reminder' });
        state.runningJobsByTaskId[binding.taskId] = { ...running, lastNotifiedAt: now.toISOString() };
        await this.saveState(state);
      }
      if (running) continue;

      const alreadyNotified = state.notifiedStatusByTaskId[binding.taskId] === taskState.status;
      const reminderHash = pendingReminderHash(taskState);
      const sameReminder = reminderHash && state.lastReminderHashByTaskId[binding.taskId] === reminderHash;
      if (alreadyNotified && sameReminder) continue;
      if (alreadyNotified && !shouldSendUserWaitingReminder(
        taskState.status,
        state.notifiedStatusAtByTaskId[binding.taskId],
        now,
      )) continue;
      await this.sendOutbound(chatId, await this.conversation.composeStateNotification(taskState));
      state.notifiedStatusByTaskId[binding.taskId] = taskState.status;
      state.notifiedStatusAtByTaskId[binding.taskId] = now.toISOString();
      if (reminderHash) {
        state.lastReminderHashByTaskId[binding.taskId] = reminderHash;
      } else {
        delete state.lastReminderHashByTaskId[binding.taskId];
      }
      await this.saveState(state);
    }
  }

  private async handlePairing(message: LarkIncomingMessage): Promise<boolean> {
    const match = message.text.trim().match(/^\/pair\s+(\S+)\s*$/i);
    if (!match) return false;

    const state = await this.loadState();
    if (match[1] !== state.pairingCode) {
      await this.sendText(message.chatId, '配对码不对。请看本地 Manager bridge 终端里打印的 pairing code。', { action: 'pair_failed' });
      return true;
    }

    await this.saveState(addPairedOpenId(state, message.senderOpenId));
    await this.sendText(message.chatId, `配对成功。我已经认识你了：${message.senderOpenId}`, { action: 'pair_succeeded' });
    return true;
  }

  private async handleTaskChatMessage(message: LarkIncomingMessage, taskId: string): Promise<void> {
    const explicitTaskRequest = parseExplicitTaskRequest(message.text);
    if (explicitTaskRequest) {
      const taskState = await this.artifactStore.loadState(taskId).catch(() => undefined);
      const options: { allowFallbackToCurrentChat?: boolean; projectId?: string } = {
        allowFallbackToCurrentChat: false,
      };
      if (taskState?.projectId) options.projectId = taskState.projectId;
      await this.auditInbound(message, { boundTaskId: taskId, action: 'create_new_task', outcome: 'task_chat_direct_task_request' });
      await this.createTaskFromMessage(message, explicitTaskRequest, options);
      return;
    }

    const turn = await this.conversation.routeTaskMessage(taskId, message.text);
    await this.auditInbound(message, {
      boundTaskId: taskId,
      ...(turn.auditAction ? { action: turn.auditAction } : {}),
      ...(turn.auditMetadata ?? {}),
      outcome: turn.kind,
    });
    if (turn.kind === 'reply') {
      for (const outbound of turn.messages) {
        await this.sendOutbound(message.chatId, outbound);
      }
      return;
    }

    const state = await this.loadState();
    const running = state.runningJobsByTaskId[taskId];
    if (running) {
      await this.sendText(message.chatId, `这个 task 正在运行：${running.label}。请等这一步结束后再发新的状态变更。`, { taskId, action: 'running_busy' });
      return;
    }

    await this.sendText(message.chatId, turn.startedMessage.text, { taskId, action: turn.auditAction ?? 'task_background_started' });
    await this.runBackgroundJob(message.chatId, taskId, 'task reply', turn.run);
  }

  private async handleUnboundCommand(
    chatId: string,
    command: 'status' | 'summary' | 'help' | 'stop',
    pendingProposal: LarkPendingTaskProposal | undefined,
  ): Promise<void> {
    if (command === 'help') {
      await this.sendText(chatId, renderControlHelp(pendingProposal), { action: 'help' });
      return;
    }
    if (command === 'stop') {
      await this.sendText(chatId, NO_TASK_TO_STOP_MESSAGE, { action: 'stop_no_task' });
      return;
    }
    if (pendingProposal) {
      await this.sendText(chatId, renderControlStatus(command, pendingProposal), { action: command });
      return;
    }
    await this.sendText(chatId, [
      `这个聊天里没有正在绑定的 task，无法执行 ${command}。`,
      '',
      '如果要直接创建任务，可以用命令：create task: <任务内容>',
    ].join('\n'), { action: command });
  }

  private async handleControlChatMessage(
    message: LarkIncomingMessage,
    pendingProposal: LarkPendingTaskProposal | undefined,
    activeProjectId: string | undefined,
  ): Promise<void> {
    const projectId = detectMentionedProjectId(this.config, message.text) ?? activeProjectId ?? getDefaultProjectId(this.config);
    const turn = await this.conversation.routeControlMessage(message.text, pendingProposal, projectId);
    if (turn.kind === 'reply') {
      await this.sendOutbound(message.chatId, turn.message);
      return;
    }
    if (turn.kind === 'confirm_pending_proposal') {
      await this.confirmPendingProposal(message, pendingProposal, turn.message);
      return;
    }
    if (turn.kind === 'cancel_pending_proposal') {
      await this.cancelPendingProposal(message.chatId, pendingProposal, turn.message);
      return;
    }

    const state = await this.loadState();
    state.pendingProposalsByChatId[message.chatId] = makePendingProposal(turn.proposal, message);
    await this.saveState(state);
    await this.sendOutbound(message.chatId, turn.message);
  }

  private async confirmPendingProposal(
    message: LarkIncomingMessage,
    pendingProposal: LarkPendingTaskProposal | undefined,
    fallbackMessage?: OutboundMessage,
  ): Promise<void> {
    if (!pendingProposal) {
      await this.sendOutbound(message.chatId, fallbackMessage ?? { text: noPendingProposalMessage('我这边没有正在等待确认的任务草案，所以没有创建任务。') });
      return;
    }

    const state = await this.loadState();
    delete state.pendingProposalsByChatId[message.chatId];
    await this.saveState(state);
    await this.createTaskFromMessage(message, { title: pendingProposal.title, task: pendingProposal.task });
  }

  private async cancelPendingProposal(
    chatId: string,
    pendingProposal: LarkPendingTaskProposal | undefined,
    fallbackMessage?: OutboundMessage,
  ): Promise<void> {
    if (!pendingProposal) {
      await this.sendOutbound(chatId, fallbackMessage ?? { text: noPendingProposalMessage('我这边没有正在等待处理的任务草案。') });
      return;
    }

    const state = await this.loadState();
    delete state.pendingProposalsByChatId[chatId];
    await this.saveState(state);
    await this.sendOutbound(chatId, fallbackMessage ?? { text: '已取消这份任务草案，没有创建任务。' });
  }

  private async createTaskFromMessage(
    message: LarkIncomingMessage,
    taskRequest: { title: string; task: string },
    options: { allowFallbackToCurrentChat?: boolean; projectId?: string } = {},
  ): Promise<void> {
    const stateBeforeCreate = await this.loadState();
    const projectId = options.projectId ?? stateBeforeCreate.activeProjectIdByChatId[message.chatId] ?? getDefaultProjectId(this.config);
    const created = await this.conversation.createTask({ ...taskRequest, projectId });
    const memberOpenIds = unique([message.senderOpenId, ...this.config.lark.taskMemberOpenIds]);
    let taskChatId = message.chatId;
    const allowFallbackToCurrentChat = options.allowFallbackToCurrentChat ?? true;
    try {
      taskChatId = await this.client.createTaskChat({
        name: `Manager - ${created.state.title}`,
        memberOpenIds,
      });
    } catch (error) {
      if (!allowFallbackToCurrentChat) {
        await this.sendText(message.chatId, [
          '任务已创建，但单独创建 Lark 群失败；当前聊天会继续绑定这个 task。',
          `任务 ID：${created.state.taskId}`,
          error instanceof Error ? error.message : String(error),
        ].join('\n'), { action: 'create_task_chat_failed' });
        return;
      }
      await this.sendText(message.chatId, [
        'task 已创建，但自动建 Lark 群失败；我先把当前聊天绑定到这个 task。',
        error instanceof Error ? error.message : String(error),
      ].join('\n'), { action: 'create_task_chat_fallback' });
    }

    const state = await this.loadState();
    state.bindingsByChatId[taskChatId] = {
      taskId: created.state.taskId,
      title: created.state.title,
      createdAt: new Date().toISOString(),
    };
    await this.saveState(state);

    await this.sendText(taskChatId, [
      `任务已创建：${created.state.title}`,
      `任务 ID：${created.state.taskId}`,
      '我开始生成 brief，跑完通知你。',
    ].join('\n'), { taskId: created.state.taskId, action: 'task_created' });

    const turn = this.conversation.startBrief(created.state.taskId);
    await this.runBackgroundJob(taskChatId, created.state.taskId, 'brief generation', turn.run);
  }

  private async runBackgroundJob(
    chatId: string,
    taskId: string,
    label: string,
    run: () => Promise<WorkflowResult>,
  ): Promise<void> {
    const state = await this.loadState();
    const startedAt = new Date().toISOString();
    state.runningJobsByTaskId[taskId] = { taskId, label, startedAt, lastNotifiedAt: startedAt };
    await this.saveState(state);

    void run()
      .then((result) => this.notifyJobDone(chatId, taskId, result))
      .catch((error: unknown) => this.notifyJobError(chatId, taskId, error));
  }

  private async notifyJobDone(chatId: string, taskId: string, result: WorkflowResult): Promise<void> {
    await this.sendOutbound(chatId, await this.conversation.composeWorkflowResult(result));
    const state = await this.loadState();
    delete state.runningJobsByTaskId[taskId];
    state.notifiedStatusByTaskId[taskId] = result.state.status;
    state.notifiedStatusAtByTaskId[taskId] = new Date().toISOString();
    const reminderHash = pendingReminderHash(result.state);
    if (reminderHash) {
      state.lastReminderHashByTaskId[taskId] = reminderHash;
    } else {
      delete state.lastReminderHashByTaskId[taskId];
    }
    await this.saveState(state);
  }

  private async notifyJobError(chatId: string, taskId: string, error: unknown): Promise<void> {
    const state = await this.loadState();
    delete state.runningJobsByTaskId[taskId];
    await this.saveState(state);
    await this.sendText(chatId, `后台任务失败：${error instanceof Error ? error.message : String(error)}`, { taskId, action: 'background_error' });
  }

  private canCreateTaskFromChat(chatId: string): boolean {
    return this.config.lark.controlChatIds.length === 0 || this.config.lark.controlChatIds.includes(chatId);
  }

  private async handleProjectCommand(
    message: LarkIncomingMessage,
    command: ProjectCommand,
    boundTaskId?: string,
  ): Promise<void> {
    const state = await this.loadState();
    if (command.kind === 'list') {
      await this.sendText(message.chatId, renderProjectList(this.config, state.activeProjectIdByChatId[message.chatId]), { action: 'project_list' });
      return;
    }
    if (command.kind === 'status') {
      const activeProjectId = state.activeProjectIdByChatId[message.chatId] ?? getDefaultProjectId(this.config);
      const active = requireProject(this.config, activeProjectId);
      const taskLine = boundTaskId ? `已绑定 task：${boundTaskId}` : '已绑定 task：无';
      await this.sendText(message.chatId, [
        `当前项目：${active.name} (${active.id})`,
        `目标工作区：${active.targetDir}`,
        `文档目录：${active.docsDir}`,
        taskLine,
      ].join('\n'), { action: 'project_status' });
      return;
    }
    if (command.kind === 'none') {
      delete state.activeProjectIdByChatId[message.chatId];
      await this.saveState(state);
      await this.sendText(message.chatId, `已清除项目选择。新任务会使用默认项目：${getDefaultProjectId(this.config)}`, { action: 'project_none' });
      return;
    }

    const project = findProject(this.config, command.projectId);
    if (!project) {
      await this.sendText(message.chatId, [
        `未知项目：${command.projectId}`,
        '可用项目：',
        renderProjectList(this.config, state.activeProjectIdByChatId[message.chatId]),
      ].join('\n'), { action: 'project_unknown' });
      return;
    }
    state.activeProjectIdByChatId[message.chatId] = project.id;
    await this.saveState(state);
    await this.sendText(message.chatId, `当前项目已切换为 ${project.name} (${project.id})。`, { action: 'project_use' });
  }

  private async sendOutbound(chatId: string, outbound: OutboundMessage): Promise<void> {
    await this.sendText(chatId, outbound.text, { action: 'outbound_message' });
    for (const file of outbound.files ?? []) {
      await this.sendFile(chatId, file, { action: 'outbound_file' });
    }
  }

  private async sendText(chatId: string, text: string, metadata: { taskId?: string; action?: string } = {}): Promise<void> {
    try {
      await this.client.sendText(chatId, text);
      await this.auditOutbound({ chatId, kind: 'text', success: true, text, ...metadata });
    } catch (error) {
      await this.auditOutbound({ chatId, kind: 'text', success: false, text, error: errorMessage(error), ...metadata });
      throw error;
    }
  }

  private async sendFile(chatId: string, file: { path: string; name: string }, metadata: { taskId?: string; action?: string } = {}): Promise<void> {
    try {
      await this.client.sendFile(chatId, file);
      await this.auditOutbound({ chatId, kind: 'file', success: true, file, ...metadata });
    } catch (error) {
      await this.auditOutbound({ chatId, kind: 'file', success: false, file, error: errorMessage(error), ...metadata });
      throw error;
    }
  }

  private async auditInbound(
    message: LarkIncomingMessage,
    metadata: { boundTaskId?: string; action?: string; outcome: string; error?: string; [key: string]: unknown },
  ): Promise<void> {
    await this.appendAudit('lark-inbound.jsonl', {
      at: new Date().toISOString(),
      eventId: message.eventId,
      messageId: message.messageId,
      chatId: message.chatId,
      senderOpenId: message.senderOpenId,
      text: message.text,
      ...metadata,
    });
  }

  private async auditOutbound(entry: Record<string, unknown>): Promise<void> {
    await this.appendAudit('lark-outbound.jsonl', {
      at: new Date().toISOString(),
      ...entry,
    });
  }

  private async appendAudit(fileName: string, entry: Record<string, unknown>): Promise<void> {
    try {
      const path = join(this.artifactStore.baseDir, fileName);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      console.error(`Failed to write ${fileName}: ${errorMessage(error)}`);
    }
  }

  private async loadState(): Promise<LarkBridgeState> {
    this.state = this.state ?? await this.stateStore.load();
    return this.state;
  }

  private async saveState(state: LarkBridgeState): Promise<void> {
    this.state = state;
    await this.stateStore.save(state);
  }
}

const USER_WAITING_REMINDER_MS = 10 * 60 * 1000;
const RUNNING_REMINDER_MS = 5 * 60 * 1000;

function shouldSendUserWaitingReminder(status: string, lastNotifiedAt: string | undefined, now: Date): boolean {
  if (![
    'awaiting_brief_confirmation',
    'awaiting_difficulty_selection',
    'waiting_user_direction',
    'ready_for_decision',
    'awaiting_user_acceptance',
  ].includes(status)) {
    return false;
  }
  const last = lastNotifiedAt ? Date.parse(lastNotifiedAt) : Number.NaN;
  return Number.isNaN(last) || now.getTime() - last >= USER_WAITING_REMINDER_MS;
}

function shouldSendRunningReminder(lastNotifiedAt: string | undefined, now: Date): boolean {
  const last = lastNotifiedAt ? Date.parse(lastNotifiedAt) : Number.NaN;
  return Number.isNaN(last) || now.getTime() - last >= RUNNING_REMINDER_MS;
}

function pendingReminderHash(taskState: { taskId: string; status: string; pendingUserPrompt?: string }): string | undefined {
  if (!taskState.pendingUserPrompt) return undefined;
  return [
    taskState.taskId,
    taskState.status,
    createHash('sha1').update(taskState.pendingUserPrompt).digest('hex'),
  ].join('|');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderRunningReminder(
  taskState: Pick<TaskState, 'title' | 'taskId' | 'status'>,
  job: { label: string; startedAt: string },
  now: Date,
): string {
  const started = Date.parse(job.startedAt);
  const elapsedMinutes = Number.isNaN(started) ? undefined : Math.max(1, Math.floor((now.getTime() - started) / 60000));
  return [
    `我还在处理这个 task：${taskState.title}`,
    `任务 ID：${taskState.taskId}`,
    `当前步骤：${job.label}`,
    `当前阶段：${humanStageName(taskState.status)}`,
    elapsedMinutes ? `已经运行约 ${elapsedMinutes} 分钟。` : undefined,
    '跑完这一阶段我会继续发结果。你也可以直接问我进度或问题。',
  ].filter(Boolean).join('\n');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

type ProjectCommand =
  | { kind: 'list' }
  | { kind: 'status' }
  | { kind: 'none' }
  | { kind: 'use'; projectId: string };

function parseProjectCommand(text: string): ProjectCommand | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/?project(?:\s+([\s\S]+))?$/i);
  const body = match?.[1]?.trim();
  if (!match || !body) return undefined;
  if (/^list$/i.test(body)) return { kind: 'list' };
  if (/^status$/i.test(body)) return { kind: 'status' };
  if (/^none$/i.test(body)) return { kind: 'none' };
  const use = body.match(/^use\s+(\S+)$/i);
  if (use?.[1]) return { kind: 'use', projectId: use[1] };
  return undefined;
}

function detectMentionedProjectId(config: ManagerConfig, text: string): string | undefined {
  const normalized = text.toLocaleLowerCase();
  return config.projects?.find((project) => {
    const candidates = [project.id, project.name].map((value) => value.toLocaleLowerCase());
    return candidates.some((candidate) => candidate.length > 0 && normalized.includes(candidate));
  })?.id;
}

function makePendingProposal(
  proposal: TaskProposal,
  message: LarkIncomingMessage,
  originalMessage = message.text,
): LarkPendingTaskProposal {
  return {
    ...proposal,
    originalMessage,
    requesterOpenId: message.senderOpenId,
    updatedAt: new Date().toISOString(),
  };
}

function noPendingProposalMessage(reason: string): string {
  return [
    reason,
    '没有创建任务。',
    '',
    '你可以继续正常提问；如果要直接创建任务，请用：create task: <任务内容>',
  ].join('\n');
}

function renderControlStatus(command: 'status' | 'summary', proposal: LarkPendingTaskProposal): string {
  const prefix = command === 'summary' ? '控制聊天总结：' : '控制聊天状态：';
  return [
    prefix,
    '当前聊天没有绑定正在运行的 workflow task。',
    '',
    '待确认的任务草案：',
    renderTaskProposal(proposal),
    '',
    '可继续这样说：',
    '- 创建任务',
    '- 修改：<说明>',
    '- 取消',
  ].join('\n');
}

function renderControlHelp(pendingProposal?: LarkPendingTaskProposal): string {
  return [
    'Elon Ma 飞书用法：',
    '- create task: <任务内容>：直接创建新 task',
    '- /create <任务内容>：直接创建新 task',
    '- new task: <任务内容>：直接创建新 task',
    '- 创建任务 / create task / confirm：确认当前任务草案',
    '- 修改：<说明> / edit: <instruction>：修改当前任务草案',
    '- 取消 / cancel：取消当前任务草案',
    '- status / summary：在 task 聊天里查看当前 task',
    '- stop：停止已绑定的 task；当前聊天没有可停止的 task',
    pendingProposal ? '' : undefined,
    pendingProposal ? '当前待确认的任务草案：' : undefined,
    pendingProposal ? `- ${pendingProposal.title}` : undefined,
  ].filter(Boolean).join('\n');
}
