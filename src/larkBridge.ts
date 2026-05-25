import { access, appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ArtifactStore } from './artifacts.js';
import { BridgeAgentService, type BridgeAgentTurn, type BridgeOutboundMessage } from './bridgeAgent.js';
import { isStopCommand } from './conversation.js';
import type { AssistantConfig, TaskState } from './types.js';
import type { WorkflowResult } from './workflow.js';
import {
  appendRecentMessage,
  bindTaskToProjectChat,
  findIdleProjectChat,
  getChatSummary,
  getRecentMessages,
  isAuthorizedOpenId,
  listProjectChats,
  registerProjectChat,
  releaseProjectChatTask,
  rememberEvent,
  type ActiveTaskBinding,
  type ChatMemoryMessage,
  type LarkBridgeState,
  type LarkRunningJob,
  LarkBridgeStateStore,
  type ProjectChatRegistration,
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

export class LarkTransport {
  private readonly inFlightEventIds = new Set<string>();
  private state: LarkBridgeState | undefined;

  constructor(
    private readonly config: AssistantConfig,
    private readonly artifactStore: ArtifactStore,
    private readonly client: LarkClientPort,
    private readonly agent: BridgeAgentService,
    private readonly stateStore: LarkBridgeStateStore,
  ) {}

  async start(): Promise<void> {
    this.state = await this.stateStore.load();
    await this.releaseOrphanedRunningJobs();
    if (this.config.lark.allowedOpenIds.length === 0) {
      console.warn('Lark transport has no allowedOpenIds configured; all incoming user messages will be ignored.');
    }
    await this.client.start((message) => {
      void this.handleMessage(message).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
      });
    });
  }

  stop(): void {}

  private async releaseOrphanedRunningJobs(): Promise<void> {
    const state = await this.loadState();
    const orphanedJobs = Object.values(state.runningJobsByTaskId);
    if (orphanedJobs.length === 0) return;

    state.runningJobsByTaskId = {};
    await this.saveState(state);

    for (const job of orphanedJobs) {
      const chatId = findChatIdForTask(state, job.taskId);
      if (!chatId) {
        await this.auditOutbound({
          kind: 'orphaned_running_job',
          success: true,
          taskId: job.taskId,
          label: job.label,
          startedAt: job.startedAt,
          action: 'orphaned_running_job_released_no_chat',
        });
        continue;
      }
      await this.notifyOrphanedRunningJob(chatId, job);
    }
  }

  private async notifyOrphanedRunningJob(chatId: string, job: LarkRunningJob): Promise<void> {
    const message = [
      '检测到上次 Manager 启动留下的后台任务标记，但当前进程没有对应 worker。',
      `任务 ID：${job.taskId}`,
      `后台任务：${job.label}`,
      `开始时间：${job.startedAt}`,
      '我已清除这个假 in-progress 标记；任务本身状态没有自动修改，也不会自动推断完成。',
      '你可以查看当前状态或相关 artifacts，或明确说 stop 停止；如果要重做，可以用 restart 重新开始。',
    ].join('\n');

    await this.sendText(chatId, message, { taskId: job.taskId, action: 'orphaned_running_job_released' })
      .then(() => this.recordAssistantText(chatId, message))
      .catch(() => undefined);
  }

  async handleMessage(message: LarkIncomingMessage): Promise<void> {
    const state = await this.loadState();
    const initialActiveTask = state.activeTaskByChatId[message.chatId];
    await this.auditInbound(message, {
      ...(initialActiveTask ? { boundTaskId: initialActiveTask.taskId } : {}),
      outcome: 'received',
    });
    if (state.processedEventIds.includes(message.eventId)) {
      await this.auditInbound(message, {
        ...(initialActiveTask ? { boundTaskId: initialActiveTask.taskId } : {}),
        outcome: 'duplicate_ignored',
      });
      return;
    }
    if (this.inFlightEventIds.has(message.eventId)) {
      await this.auditInbound(message, {
        ...(initialActiveTask ? { boundTaskId: initialActiveTask.taskId } : {}),
        outcome: 'duplicate_in_flight_ignored',
      });
      return;
    }

    this.inFlightEventIds.add(message.eventId);
    try {
      await this.processMessage(message);
      await this.markEventProcessed(message.eventId);
    } catch (error) {
      const current = await this.loadState().catch(() => state);
      const activeTask = current.activeTaskByChatId[message.chatId] ?? initialActiveTask;
      await this.auditInbound(message, {
        ...(activeTask ? { boundTaskId: activeTask.taskId } : {}),
        outcome: 'handler_error',
        error: errorMessage(error),
      });
      await this.sendProcessingFailure(message.chatId, activeTask?.taskId, error).catch((sendError: unknown) => {
        console.error(`Failed to report Lark message handling error: ${errorMessage(sendError)}`);
      });
    } finally {
      this.inFlightEventIds.delete(message.eventId);
    }
  }

  private async processMessage(message: LarkIncomingMessage): Promise<void> {
    const current = await this.loadState();
    if (!isAuthorizedOpenId(this.config, message.senderOpenId)) {
      await this.auditInbound(message, { outcome: 'unauthorized_ignored' });
      return;
    }

    const recentMessagesSnapshot = snapshotRecentMessages(current, message.chatId);
    const chatSummarySnapshot = getChatSummary(current, message.chatId);
    await this.recordUserMessage(message);

    let projectChat = current.projectChatsByChatId[message.chatId];
    const chatKind = projectChat ? 'project' : 'control';
    let activeTask = projectChat ? await this.resolveActiveTaskBinding(current, projectChat) : undefined;

    if (projectChat && activeTask) {
      const boundTask = await this.artifactStore.loadState(activeTask.taskId).catch(() => undefined);
      if (!boundTask) {
        await this.auditInbound(message, { boundTaskId: activeTask.taskId, outcome: 'stale_active_task_released' });
        releaseProjectChatTask(current, message.chatId, activeTask.taskId);
        await this.saveState(current);
        projectChat = current.projectChatsByChatId[message.chatId];
        activeTask = undefined;
      } else if (isIdleProjectChatState(boundTask)) {
        await this.auditInbound(message, { boundTaskId: activeTask.taskId, outcome: 'completed_active_task_released' });
        releaseProjectChatTask(current, message.chatId, activeTask.taskId);
        await this.saveState(current);
        projectChat = current.projectChatsByChatId[message.chatId];
        activeTask = undefined;
      }
    }

    if (activeTask && isStopCommand(message.text)) {
      await this.dispatchTurn(message.chatId, await this.agent.stopTask(activeTask.taskId), message.senderOpenId);
      return;
    }

    const activeProjectId = projectChat?.projectId ?? current.activeProjectIdByChatId[message.chatId];
    const turn = await this.agent.handleMessage({
      chatId: message.chatId,
      senderOpenId: message.senderOpenId,
      text: message.text,
      chatKind,
      ...(projectChat ? {
        projectChat: {
          projectId: projectChat.projectId,
          ...(projectChat.name ? { name: projectChat.name } : {}),
          hasActiveTask: Boolean(activeTask),
        },
      } : {}),
      ...(activeTask ? { activeTask } : {}),
      ...(activeTask && current.runningJobsByTaskId[activeTask.taskId] ? { runningJob: current.runningJobsByTaskId[activeTask.taskId] } : {}),
      ...(activeProjectId ? { activeProjectId } : {}),
      projectChatsSummary: projectChatsSummary(current),
      canCreateTask: this.canCreateTaskFromChat(message.chatId, current),
      ...(recentMessagesSnapshot.length > 0 ? { recentMessages: recentMessagesSnapshot } : {}),
      ...(chatSummarySnapshot ? { chatSummary: chatSummarySnapshot } : {}),
    });
    await this.auditInbound(message, {
      ...(activeTask ? { boundTaskId: activeTask.taskId } : {}),
      ...(turn.auditAction ? { action: turn.auditAction } : {}),
      outcome: turn.kind,
    });
    await this.dispatchTurn(message.chatId, turn, message.senderOpenId);
  }

  private async resolveActiveTaskBinding(
    state: LarkBridgeState,
    projectChat: ProjectChatRegistration,
  ): Promise<ActiveTaskBinding | undefined> {
    const activeTask = state.activeTaskByChatId[projectChat.chatId];
    if (activeTask) return activeTask;
    if (!projectChat.activeTaskId) return undefined;
    const task = await this.artifactStore.loadState(projectChat.activeTaskId).catch(() => undefined);
    if (!task || isIdleProjectChatState(task)) {
      releaseProjectChatTask(state, projectChat.chatId, projectChat.activeTaskId);
      await this.saveState(state);
      return undefined;
    }
    const binding: ActiveTaskBinding = {
      chatId: projectChat.chatId,
      taskId: task.taskId,
      title: task.title,
      startedAt: task.createdAt,
    };
    state.activeTaskByChatId[projectChat.chatId] = binding;
    await this.saveState(state);
    return binding;
  }

  private async dispatchTurn(chatId: string, turn: BridgeAgentTurn, senderOpenId?: string): Promise<void> {
    if (turn.kind === 'reply') {
      const state = await this.loadState();
      const projectChat = state.projectChatsByChatId[chatId];
      if (!projectChat) {
        if (turn.activeProjectId === null) {
          delete state.activeProjectIdByChatId[chatId];
        } else if (turn.activeProjectId) {
          state.activeProjectIdByChatId[chatId] = turn.activeProjectId;
        }
      }
      if (turn.clearRunningTaskId) {
        delete state.runningJobsByTaskId[turn.clearRunningTaskId];
      }
      if (turn.clearActiveTask) {
        releaseProjectChatTask(state, chatId, turn.clearActiveTask.taskId);
      }
      await this.saveState(state);
      for (const outbound of turn.messages) {
        await this.sendOutbound(chatId, outbound);
      }
      return;
    }

    if (turn.kind === 'task_created') {
      await this.bindCreatedTaskChat(chatId, senderOpenId, turn);
      return;
    }

    if (turn.kind === 'task_dispatched_to_chat') {
      await this.dispatchTaskToProjectChat(chatId, turn);
      return;
    }

    if (turn.kind === 'project_chat_create_requested') {
      await this.createProjectChat(chatId, senderOpenId, turn);
      return;
    }

    await this.sendOutbound(chatId, turn.startedMessage);
    await this.runBackgroundJob(chatId, turn.taskId, turn.label, turn.run);
  }

  private async bindCreatedTaskChat(chatId: string, senderOpenId: string | undefined, turn: Extract<BridgeAgentTurn, { kind: 'task_created' }>): Promise<void> {
    const state = await this.loadState();
    const existingProjectChat = state.projectChatsByChatId[chatId];
    const projectId = turn.projectId ?? existingProjectChat?.projectId ?? state.activeProjectIdByChatId[chatId] ?? this.config.defaultProjectId ?? 'default';

    if (existingProjectChat) {
      if (existingProjectChat.activeTaskId || state.activeTaskByChatId[chatId]) {
        const busyMessage = '这个 Project Chat 正在运行另一个 task，不能同时塞第二个 task。';
        await this.sendText(chatId, busyMessage, { taskId: turn.taskId, action: 'project_chat_busy' });
        await this.recordAssistantText(chatId, busyMessage);
        return;
      }
      bindTaskToProjectChat(state, chatId, {
        taskId: turn.taskId,
        title: turn.title,
        projectId,
      });
      await this.saveState(state);
      for (const outbound of turn.messages) {
        await this.sendOutbound(chatId, outbound);
      }
      return;
    }

    const memberOpenIds = unique([senderOpenId, ...this.config.lark.taskMemberOpenIds].filter((value): value is string => Boolean(value)));
    const chatName = nextProjectChatName(state, projectId, turn.projectName);
    let taskChatId = chatId;
    try {
      taskChatId = await this.client.createTaskChat({
        name: chatName,
        memberOpenIds,
      });
    } catch (error) {
      const fallbackMessage = [
        'task 已创建，但自动创建 Project Chat 失败；我先把当前聊天注册为这个项目的 Project Chat。',
        errorMessage(error),
      ].join('\n');
      await this.sendText(chatId, fallbackMessage, { taskId: turn.taskId, action: 'create_project_chat_fallback' });
      await this.recordAssistantText(chatId, fallbackMessage);
    }

    const next = await this.loadState();
    bindTaskToProjectChat(next, taskChatId, {
      taskId: turn.taskId,
      title: turn.title,
      projectId,
      chatName,
    });
    if (!next.projectChatsByChatId[taskChatId]?.name) {
      registerProjectChat(next, { chatId: taskChatId, projectId, name: chatName });
    }
    await this.saveState(next);

    for (const outbound of turn.messages) {
      await this.sendOutbound(taskChatId, outbound);
    }
  }

  private async dispatchTaskToProjectChat(originChatId: string, turn: Extract<BridgeAgentTurn, { kind: 'task_dispatched_to_chat' }>): Promise<void> {
    const state = await this.loadState();
    const target = state.projectChatsByChatId[turn.targetChatId];
    if (!target || target.projectId !== turn.projectId) {
      const missingMessage = `没有找到项目 ${turn.projectName ?? turn.projectId} 的目标 Project Chat。`;
      await this.sendText(originChatId, missingMessage, { taskId: turn.taskId, action: 'dispatch_target_missing' });
      await this.recordAssistantText(originChatId, missingMessage);
      return;
    }
    if (target.activeTaskId || state.activeTaskByChatId[turn.targetChatId]) {
      const retry = findIdleProjectChat(state, turn.projectId);
      if (!retry) {
        const busyMessage = `项目 ${turn.projectName ?? turn.projectId} 的 Project Chat 都在忙。要不要我新建一个 Project Chat？`;
        await this.sendText(originChatId, busyMessage, { taskId: turn.taskId, action: 'dispatch_target_busy' });
        await this.recordAssistantText(originChatId, busyMessage);
        return;
      }
      turn = { ...turn, targetChatId: retry.chatId };
    }

    bindTaskToProjectChat(state, turn.targetChatId, {
      taskId: turn.taskId,
      title: turn.title,
      projectId: turn.projectId,
    });
    await this.saveState(state);

    for (const outbound of turn.targetMessages) {
      await this.sendOutbound(turn.targetChatId, outbound);
    }
    if (turn.originReply && originChatId !== turn.targetChatId) {
      await this.sendOutbound(originChatId, turn.originReply);
    }
  }

  private async createProjectChat(originChatId: string, senderOpenId: string | undefined, turn: Extract<BridgeAgentTurn, { kind: 'project_chat_create_requested' }>): Promise<void> {
    const state = await this.loadState();
    const memberOpenIds = unique([senderOpenId, ...this.config.lark.taskMemberOpenIds].filter((value): value is string => Boolean(value)));
    const name = turn.name ?? nextProjectChatName(state, turn.projectId, turn.projectName);
    const projectChatId = await this.client.createTaskChat({ name, memberOpenIds });
    registerProjectChat(state, {
      chatId: projectChatId,
      projectId: turn.projectId,
      name,
    });
    await this.saveState(state);
    const createdMessage = `已创建 Project Chat：${name}`;
    await this.sendText(originChatId, createdMessage, { action: 'create_project_chat' });
    await this.recordAssistantText(originChatId, createdMessage);
  }

  private async runBackgroundJob(
    chatId: string,
    taskId: string,
    label: string,
    run: () => Promise<WorkflowResult>,
  ): Promise<void> {
    const state = await this.loadState();
    const startedAt = new Date().toISOString();
    state.runningJobsByTaskId[taskId] = { taskId, label, startedAt };
    await this.saveState(state);

    void run()
      .then((result) => this.notifyJobDone(chatId, taskId, startedAt, result))
      .catch((error: unknown) => this.notifyJobError(chatId, taskId, error));
  }

  private async notifyJobDone(chatId: string, taskId: string, startedAt: string, result: WorkflowResult): Promise<void> {
    const state = await this.loadState();
    const running = state.runningJobsByTaskId[taskId];
    if (!running || running.startedAt !== startedAt) {
      await this.auditOutbound({ chatId, kind: 'stale_job_result', success: true, taskId, action: 'background_stale_ignored' });
      return;
    }
    delete state.runningJobsByTaskId[taskId];
    if (isIdleProjectChatState(result.state)) {
      releaseProjectChatTask(state, chatId, taskId);
    }
    await this.saveState(state);
    await this.sendOutbound(chatId, workflowMessage(result));
  }

  private async notifyJobError(chatId: string, taskId: string, error: unknown): Promise<void> {
    const state = await this.loadState();
    delete state.runningJobsByTaskId[taskId];
    await this.saveState(state);
    const errorText = `后台任务失败：${errorMessage(error)}`;
    await this.sendText(chatId, errorText, { taskId, action: 'background_error' });
    await this.recordAssistantText(chatId, errorText);
  }

  private canCreateTaskFromChat(chatId: string, state: LarkBridgeState): boolean {
    const projectChat = state.projectChatsByChatId[chatId];
    if (!projectChat) return true;
    return !projectChat.activeTaskId && !state.activeTaskByChatId[chatId];
  }

  private async sendOutbound(chatId: string, outbound: BridgeOutboundMessage): Promise<void> {
    await this.sendText(chatId, outbound.text, { action: 'outbound_message' });
    await this.recordAssistantText(chatId, outbound.text);
    for (const file of outbound.files ?? []) {
      if (!await fileExists(file.path)) {
        await this.auditOutbound({ chatId, kind: 'file', success: false, file, action: 'outbound_file_missing', error: 'File does not exist.' });
        continue;
      }
      await this.sendFile(chatId, file, { action: 'outbound_file' });
    }
  }

  private async recordUserMessage(message: LarkIncomingMessage): Promise<void> {
    const trimmed = message.text?.trim();
    if (!trimmed) return;
    const state = await this.loadState();
    const entry: ChatMemoryMessage = {
      role: 'user',
      text: message.text,
      at: new Date().toISOString(),
    };
    if (message.messageId) entry.messageId = message.messageId;
    if (message.eventId) entry.eventId = message.eventId;
    appendRecentMessage(state, message.chatId, entry);
    await this.saveState(state);
  }

  private async recordAssistantText(chatId: string, text: string): Promise<void> {
    const trimmed = text?.trim();
    if (!trimmed) return;
    const state = await this.loadState();
    appendRecentMessage(state, chatId, {
      role: 'assistant',
      text,
      at: new Date().toISOString(),
    });
    await this.saveState(state);
  }

  private async sendProcessingFailure(chatId: string, taskId: string | undefined, error: unknown): Promise<void> {
    await this.sendText(chatId, [
      '我收到你的消息了，但 transport 在交给 Elon Ma 或执行工具时遇到了内部错误。',
      '这条 event 没有记成 processed，你可以安全重试同一个操作。',
      `Error: ${errorMessage(error)}`,
    ].join('\n'), { ...(taskId ? { taskId } : {}), action: 'message_handler_error' });
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

  private async markEventProcessed(eventId: string): Promise<void> {
    await this.saveState(rememberEvent(await this.loadState(), eventId));
  }
}

export { LarkTransport as LarkBridge };

function workflowMessage(result: WorkflowResult): BridgeOutboundMessage {
  const files = filesForWorkflowResult(result);
  return { text: result.message, ...(files ? { files } : {}) };
}

function filesForWorkflowResult(result: WorkflowResult): BridgeOutboundMessage['files'] {
  const state = result.state;
  const artifactNames = [];
  if (state.status === 'ready_for_decision') artifactNames.push('assistant-explanation', 'revised-plan');
  if (state.status === 'awaiting_user_acceptance') artifactNames.push('final-review', 'test-build-log');
  if (state.status === 'completed') artifactNames.push('final-report');
  const files = artifactNames
    .map((artifact) => state.artifacts[artifact as keyof typeof state.artifacts])
    .filter((path): path is string => Boolean(path))
    .map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? 'artifact' }));
  return files.length > 0 ? files : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function nextProjectChatName(state: LarkBridgeState, projectId: string, projectName?: string): string {
  const sequence = listProjectChats(state, projectId).length + 1;
  return `Assistant - [${projectName ?? projectId}] #${sequence}`;
}

function projectChatsSummary(state: LarkBridgeState): Array<{ chatId: string; projectId: string; idle: boolean; name?: string }> {
  return Object.values(state.projectChatsByChatId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .map((chat) => ({
      chatId: chat.chatId,
      projectId: chat.projectId,
      idle: !chat.activeTaskId && !state.activeTaskByChatId[chat.chatId],
      ...(chat.name ? { name: chat.name } : {}),
    }));
}

function findChatIdForTask(state: LarkBridgeState, taskId: string): string | undefined {
  const activeBinding = Object.values(state.activeTaskByChatId)
    .find((binding) => binding.taskId === taskId);
  if (activeBinding) return activeBinding.chatId;

  return Object.values(state.projectChatsByChatId)
    .find((chat) => chat.activeTaskId === taskId)
    ?.chatId;
}

function snapshotRecentMessages(state: LarkBridgeState, chatId: string): ChatMemoryMessage[] {
  return getRecentMessages(state, chatId).map((entry) => ({ ...entry }));
}

function isIdleProjectChatState(state: TaskState): boolean {
  return state.status === 'completed' || state.status === 'stopped';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
