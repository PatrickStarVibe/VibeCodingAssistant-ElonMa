import { basename } from 'node:path';

import type { ArtifactStore } from './artifacts.js';
import type { AssistantAdapter } from './adapters.js';
import { addProjectToRegistry, type AddProjectInput } from './projectRegistry.js';
import { getDefaultProjectId, renderProjectList, requireProject } from './projects.js';
import type {
  ArtifactName,
  BridgeAgentDecision,
  BridgeAgentInput,
  BridgeToolCall,
  AssistantConfig,
  TaskState,
  WorkflowDifficulty,
} from './types.js';
import type { WorkflowResult, WorkflowService } from './workflow.js';
import type { ActiveTaskBinding, LarkRunningJob, ProjectChatRegistration } from './larkBridgeState.js';

export interface BridgeOutboundFile {
  path: string;
  name: string;
}

export interface BridgeOutboundMessage {
  text: string;
  files?: BridgeOutboundFile[];
}

export interface BridgeAgentRequest {
  chatId: string;
  senderOpenId: string;
  text: string;
  chatKind: 'control' | 'project';
  projectChat?: {
    projectId: string;
    name?: string;
    hasActiveTask: boolean;
  };
  activeTask?: ActiveTaskBinding;
  runningJob?: LarkRunningJob;
  activeProjectId?: string;
  canCreateTask: boolean;
  projectChatsSummary?: BridgeAgentInput['projectChatsSummary'];
}

export type BridgeAgentTurn =
  | {
    kind: 'reply';
    messages: BridgeOutboundMessage[];
    auditAction?: string;
    clearRunningTaskId?: string;
    clearActiveTask?: { taskId: string };
    activeProjectId?: string | null;
  }
  | {
    kind: 'task_created';
    taskId: string;
    title: string;
    projectId?: string;
    projectName?: string;
    messages: BridgeOutboundMessage[];
    auditAction?: string;
  }
  | {
    kind: 'task_dispatched_to_chat';
    taskId: string;
    title: string;
    targetChatId: string;
    projectId: string;
    projectName?: string;
    targetMessages: BridgeOutboundMessage[];
    originReply?: BridgeOutboundMessage;
    auditAction?: string;
  }
  | {
    kind: 'project_chat_create_requested';
    projectId: string;
    projectName?: string;
    name?: string;
    auditAction?: string;
  }
  | {
    kind: 'background';
    taskId: string;
    label: string;
    startedMessage: BridgeOutboundMessage;
    run: () => Promise<WorkflowResult>;
    auditAction?: string;
  };

export class BridgeAgentService {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly store: ArtifactStore,
    private readonly assistant: AssistantAdapter,
    private readonly config: AssistantConfig,
  ) {}

  async handleMessage(request: BridgeAgentRequest): Promise<BridgeAgentTurn> {
    if (!this.assistant.decideBridgeAction) {
      return this.reply('Elon Ma bridge tool-calling is not configured yet, so I did not run any action.');
    }

    const input = await this.buildInput(request);
    const decision = await this.assistant.decideBridgeAction(input).catch((error: unknown): BridgeAgentDecision => ({
      kind: 'reply',
      text: `Elon Ma could not make a bridge decision: ${errorMessage(error)}`,
    }));

    if (decision.kind === 'reply') {
      return this.reply(decision.text);
    }
    return this.executeTool(request, decision.toolCall);
  }

  async stopTask(taskId: string): Promise<BridgeAgentTurn> {
    const result = await this.workflow.reply(taskId, 'stop');
    return {
      kind: 'reply',
      clearRunningTaskId: taskId,
      clearActiveTask: { taskId },
      ...(result.state.projectId ? { activeProjectId: result.state.projectId } : {}),
      auditAction: 'tool:stop_task',
      messages: [this.workflowMessage(result)],
    };
  }

  private async buildInput(request: BridgeAgentRequest): Promise<BridgeAgentInput> {
    const task = request.activeTask
      ? await this.store.loadState(request.activeTask.taskId).catch(() => undefined)
      : undefined;
    return {
      latestUserMessage: request.text,
      chat: {
        chatId: request.chatId,
        senderOpenId: request.senderOpenId,
        chatKind: request.chatKind,
        canCreateTask: request.canCreateTask,
        ...(request.activeProjectId ? { activeProjectId: request.activeProjectId } : {}),
        ...(request.projectChat ? { projectChat: request.projectChat } : {}),
        ...(request.activeTask ? { boundTaskId: request.activeTask.taskId } : {}),
      },
      ...(request.projectChatsSummary ? { projectChatsSummary: request.projectChatsSummary } : {}),
      ...(task ? {
        task: {
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          revisionRound: task.revisionRound,
          reviewerRunCount: task.reviewerRunCount,
          requestedChanges: task.requestedChanges,
          ...(task.difficulty ? { difficulty: task.difficulty } : {}),
          ...(task.pendingUserPrompt ? { pendingUserPrompt: task.pendingUserPrompt } : {}),
        },
      } : {}),
      ...(request.runningJob ? {
        runningJob: {
          taskId: request.runningJob.taskId,
          label: request.runningJob.label,
          startedAt: request.runningJob.startedAt,
        },
      } : {}),
      projects: (this.config.projects ?? []).map((project) => ({ id: project.id, name: project.name })),
      config: this.config,
    };
  }

  private async executeTool(request: BridgeAgentRequest, toolCall: BridgeToolCall): Promise<BridgeAgentTurn> {
    try {
      switch (toolCall.name) {
        case 'reply_to_user':
          return this.reply(requiredString(toolCall, 'text'));
        case 'create_task':
          return await this.createTask(request, toolCall, false);
        case 'create_new_task_from_task_chat':
          return await this.createTask(request, toolCall, true);
        case 'schedule_task_to_project_chat':
          return await this.scheduleTaskToProjectChat(request, toolCall);
        case 'create_project_chat':
          return this.requestProjectChatCreation(toolCall);
        case 'choose_difficulty': {
          const difficulty = requiredDifficulty(toolCall);
          return this.workflowBackground(request, toolCall, 'planning', (taskId) => {
            return this.workflow.reply(taskId, instructionReply(difficulty, optionalString(toolCall, 'instruction')));
          });
        }
        case 'approve_plan':
          return this.workflowBackground(request, toolCall, 'implementing', (taskId) => (
            this.workflow.reply(taskId, instructionReply('approve A', optionalString(toolCall, 'instruction')))
          ));
        case 'accept_task': {
          const taskId = this.resolveTaskId(request, toolCall);
          const result = await this.workflow.reply(taskId, instructionReply('accept', optionalString(toolCall, 'instruction')));
          return {
            kind: 'reply',
            ...(result.state.status === 'completed' ? { clearActiveTask: { taskId } } : {}),
            ...(result.state.projectId ? { activeProjectId: result.state.projectId } : {}),
            auditAction: 'tool:accept_task',
            messages: [this.workflowMessage(result)],
          };
        }
        case 'revise_plan': {
          const instruction = requiredString(toolCall, 'instruction');
          return this.workflowBackground(request, toolCall, 'replanning', (taskId) => (
            this.workflow.reply(taskId, `revise C: ${instruction}`)
          ));
        }
        case 'stop_task': {
          const taskId = this.resolveTaskId(request, toolCall);
          return this.stopTask(taskId);
        }
        case 'ask_task_question': {
          const taskId = this.resolveTaskId(request, toolCall);
          return {
            kind: 'reply',
            auditAction: 'tool:ask_task_question',
            messages: [this.workflowMessage(await this.workflow.askQuestion(taskId, requiredString(toolCall, 'question')))],
          };
        }
        case 'show_status':
          return await this.showStatus(request, toolCall);
        case 'show_artifact':
          return await this.showArtifact(request, toolCall);
        case 'switch_project':
          return this.switchProject(toolCall);
        case 'add_project':
          return await this.addProject(toolCall);
        case 'list_projects':
          return this.listProjects(request);
      }
    } catch (error) {
      return this.reply(`这个动作没有执行：${errorMessage(error)}`);
    }
  }

  private async createTask(request: BridgeAgentRequest, toolCall: BridgeToolCall, fromTaskChat: boolean): Promise<BridgeAgentTurn> {
    if (!request.canCreateTask) {
      return this.reply('这个 Project Chat 里已经有 active task；等它完成后再开下一个，或在 Control Chat 里创建新的 Project Chat。');
    }
    if (fromTaskChat && !request.activeTask) {
      return this.reply('当前聊天没有 active task；如果要创建新 task，可以直接发送完整 prompt。');
    }

    const prompt = requiredString(toolCall, 'prompt');
    const title = optionalString(toolCall, 'title') ?? makeTitle(prompt);
    const projectId = request.projectChat?.projectId
      ?? optionalString(toolCall, 'projectId')
      ?? request.activeProjectId
      ?? getDefaultProjectId(this.config);
    const project = requireProject(this.config, projectId);
    const created = await this.workflow.createTask({ title, task: prompt, projectId: project.id });
    const planned = await this.workflow.planTask(created.state.taskId);
    return {
      kind: 'task_created',
      taskId: created.state.taskId,
      title: created.state.title,
      projectId: project.id,
      projectName: project.name,
      auditAction: `tool:${toolCall.name}`,
      messages: [this.taskStartedMessage(planned, project.name)],
    };
  }

  private async scheduleTaskToProjectChat(request: BridgeAgentRequest, toolCall: BridgeToolCall): Promise<BridgeAgentTurn> {
    const projectId = requiredString(toolCall, 'projectId');
    const project = requireProject(this.config, projectId);
    const targetChatId = optionalString(toolCall, 'targetChatId');
    const candidates = (request.projectChatsSummary ?? [])
      .filter((chat) => chat.projectId === project.id);
    const target = targetChatId
      ? candidates.find((chat) => chat.chatId === targetChatId && chat.idle)
      : candidates.find((chat) => chat.idle);

    if (!target) {
      return this.reply(`项目 ${project.name} (${project.id}) 现在没有空闲的 Project Chat。要不要我新建一个 Project Chat？`);
    }

    const prompt = requiredString(toolCall, 'prompt');
    const title = optionalString(toolCall, 'title') ?? makeTitle(prompt);
    const created = await this.workflow.createTask({ title, task: prompt, projectId: project.id });
    const planned = await this.workflow.planTask(created.state.taskId);
    return {
      kind: 'task_dispatched_to_chat',
      taskId: created.state.taskId,
      title: created.state.title,
      targetChatId: target.chatId,
      projectId: project.id,
      projectName: project.name,
      auditAction: 'tool:schedule_task_to_project_chat',
      targetMessages: [this.taskStartedMessage(planned, project.name)],
      originReply: {
        text: `已把任务「${created.state.title}」派到 ${target.name ?? target.chatId}。`,
      },
    };
  }

  private requestProjectChatCreation(toolCall: BridgeToolCall): BridgeAgentTurn {
    const projectId = requiredString(toolCall, 'projectId');
    const project = requireProject(this.config, projectId);
    const name = optionalString(toolCall, 'name');
    return {
      kind: 'project_chat_create_requested',
      projectId: project.id,
      projectName: project.name,
      ...(name ? { name } : {}),
      auditAction: 'tool:create_project_chat',
    };
  }

  private workflowBackground(
    request: BridgeAgentRequest,
    toolCall: BridgeToolCall,
    label: string,
    run: (taskId: string) => Promise<WorkflowResult>,
  ): BridgeAgentTurn {
    const taskId = this.resolveTaskId(request, toolCall);
    if (request.runningJob?.taskId === taskId) {
      return this.reply(`这个 task 正在运行：${request.runningJob.label}。你可以继续问进度，或明确说停止任务。`);
    }
    return {
      kind: 'background',
      taskId,
      label,
      auditAction: `tool:${toolCall.name}`,
      startedMessage: { text: `收到，我开始 ${label}；完成后会把结果发到这里。` },
      run: () => run(taskId),
    };
  }

  private async showStatus(request: BridgeAgentRequest, toolCall: BridgeToolCall): Promise<BridgeAgentTurn> {
    const taskId = optionalString(toolCall, 'taskId') ?? request.activeTask?.taskId;
    if (!taskId) return this.reply('当前聊天没有 active task。');
    const state = await this.store.loadState(taskId);
    const running = request.runningJob?.taskId === taskId ? request.runningJob : undefined;
    return this.reply(renderBridgeStatus(state, running?.label));
  }

  private async showArtifact(request: BridgeAgentRequest, toolCall: BridgeToolCall): Promise<BridgeAgentTurn> {
    const taskId = this.resolveTaskId(request, toolCall);
    const artifact = requiredArtifact(toolCall);
    const content = await this.workflow.showArtifact(taskId, artifact);
    const state = await this.store.loadState(taskId);
    const path = state.artifacts[artifact];
    return {
      kind: 'reply',
      auditAction: 'tool:show_artifact',
      messages: [{
        text: [`${artifact}:`, '', shorten(content, 1200)].join('\n'),
        ...(path ? { files: [{ path, name: basename(path) }] } : {}),
      }],
    };
  }

  private switchProject(toolCall: BridgeToolCall): BridgeAgentTurn {
    const projectId = requiredString(toolCall, 'projectId');
    const project = requireProject(this.config, projectId);
    return {
      kind: 'reply',
      activeProjectId: project.id,
      auditAction: 'tool:switch_project',
      messages: [{ text: `当前聊天的新任务默认项目已切换为 ${project.name} (${project.id})。` }],
    };
  }

  private async addProject(toolCall: BridgeToolCall): Promise<BridgeAgentTurn> {
    const input: AddProjectInput = { targetDir: requiredString(toolCall, 'targetDir') };
    const id = optionalString(toolCall, 'id');
    const name = optionalString(toolCall, 'name');
    const docsDir = optionalString(toolCall, 'docsDir');
    const taskRecordRoot = optionalString(toolCall, 'taskRecordRoot');
    if (id) input.id = id;
    if (name) input.name = name;
    if (docsDir) input.docsDir = docsDir;
    if (taskRecordRoot) input.taskRecordRoot = taskRecordRoot;
    const result = await addProjectToRegistry(this.store.assistantRoot, this.config, input);
    const project = result.project;
    return {
      kind: 'reply',
      activeProjectId: project.id,
      auditAction: 'tool:add_project',
      messages: [{
        text: [
          result.created ? '项目已添加，并已切换为当前聊天的新任务默认项目。' : '这个项目已经存在，已切换为当前聊天的新任务默认项目。',
          `项目：${project.name} (${project.id})`,
          `位置：${project.targetDir}`,
          `文档目录：${project.docsDir}`,
          `task record：${project.taskRecordRoot ?? '<targetDir>/task'}`,
          result.created ? `已写入：${result.registryPath}` : undefined,
        ].filter((line): line is string => Boolean(line)).join('\n'),
      }],
    };
  }

  private listProjects(request: BridgeAgentRequest): BridgeAgentTurn {
    return {
      kind: 'reply',
      auditAction: 'tool:list_projects',
      messages: [{ text: renderProjectList(this.config, request.projectChat?.projectId ?? request.activeProjectId) }],
    };
  }

  private resolveTaskId(request: BridgeAgentRequest, toolCall: BridgeToolCall): string {
    const taskId = optionalString(toolCall, 'taskId') ?? request.activeTask?.taskId;
    if (!taskId) throw new Error('当前聊天没有 active task。');
    return taskId;
  }

  private taskStartedMessage(result: WorkflowResult, projectName: string): BridgeOutboundMessage {
    return this.workflowMessage({
      state: result.state,
      message: [
        `任务已创建：${result.state.title}`,
        `项目：${projectName} (${result.state.projectId ?? getDefaultProjectId(this.config)})`,
        `任务 ID：${result.state.taskId}`,
        '请选择工作难度：low、medium 或 high。',
      ].join('\n'),
    });
  }

  private workflowMessage(result: WorkflowResult): BridgeOutboundMessage {
    const files = filesForState(result.state);
    return {
      text: result.message,
      ...(files ? { files } : {}),
    };
  }

  private reply(text: string): BridgeAgentTurn {
    return { kind: 'reply', messages: [{ text }] };
  }
}

export function summarizeProjectChats(chats: ProjectChatRegistration[], activeByChatId: Record<string, ActiveTaskBinding>): BridgeAgentInput['projectChatsSummary'] {
  return chats.map((chat) => ({
    chatId: chat.chatId,
    projectId: chat.projectId,
    idle: !chat.activeTaskId && !activeByChatId[chat.chatId],
    ...(chat.name ? { name: chat.name } : {}),
  }));
}

function filesForState(state: TaskState): BridgeOutboundFile[] | undefined {
  const artifactNames: ArtifactName[] = [];
  if (state.status === 'ready_for_decision') artifactNames.push('assistant-explanation', 'revised-plan');
  if (state.status === 'awaiting_user_acceptance') artifactNames.push('final-review', 'test-build-log');
  if (state.status === 'completed') artifactNames.push('final-report');
  const files = artifactNames
    .map((artifact) => state.artifacts[artifact])
    .filter((path): path is string => Boolean(path))
    .map((path) => ({ path, name: basename(path) }));
  return files.length > 0 ? files : undefined;
}

function renderBridgeStatus(state: TaskState, runningLabel?: string): string {
  const lines = [
    `当前任务：${state.title}`,
    `阶段：${bridgeStageName(state.status)}`,
    `状态码：${state.status}`,
    state.difficulty ? `难度：${state.difficulty}` : undefined,
    runningLabel ? `后台正在运行：${runningLabel}` : undefined,
    '',
    bridgeNextStep(state.status),
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

function bridgeStageName(status: TaskState['status']): string {
  switch (status) {
    case 'created':
    case 'awaiting_difficulty_selection':
      return '等待选择难度';
    case 'planning_requested':
    case 'planning':
      return '规划中';
    case 'waiting_user_direction':
      return '等待你做产品方向决定';
    case 'ready_for_decision':
      return '计划已出，等待批准实现';
    case 'implementation_approved':
    case 'implementing':
    case 'execution_queue_ready':
    case 'execution_unit_implementing':
    case 'execution_unit_testing':
    case 'execution_unit_result_recording':
    case 'next_execution_unit_or_all_done':
      return '实现中';
    case 'implemented':
    case 'final_reviewing':
    case 'final_review_routing':
      return '实现完成，最终 review 中';
    case 'awaiting_user_acceptance':
      return '实现和最终 review 已完成，等待你验收';
    case 'task_recording':
      return '正在生成 task record';
    case 'completed':
      return '已完成';
    case 'stopped':
      return '已停止';
    case 'task_artifacts_persisting':
      return '保存任务产物中';
  }
}

function bridgeNextStep(status: TaskState['status']): string {
  switch (status) {
    case 'awaiting_difficulty_selection':
    case 'created':
      return '下一步：选 low / medium / high。你也可以问我为什么要选难度。';
    case 'ready_for_decision':
    case 'waiting_user_direction':
      return '下一步：如果计划没问题，可以说 approve；如果要改，直接说改哪里。';
    case 'awaiting_user_acceptance':
      return '下一步：如果结果没问题，可以说 task recording / accept；如果还要改，直接说要改哪里。';
    case 'completed':
      return '这个 task 已完成。这个 Project Chat 现在可以接下一个 task。';
    case 'stopped':
      return '这个 task 已停止。这个 Project Chat 现在可以接下一个 task。';
    default:
      return '下一步：你可以问我当前进度，也可以明确说停止任务。';
  }
}

function requiredString(toolCall: BridgeToolCall, key: string): string {
  const value = optionalString(toolCall, key);
  if (!value) throw new Error(`${toolCall.name} requires ${key}.`);
  return value;
}

function optionalString(toolCall: BridgeToolCall, key: string): string | undefined {
  const value = toolCall.arguments[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredDifficulty(toolCall: BridgeToolCall): WorkflowDifficulty {
  const difficulty = requiredString(toolCall, 'difficulty');
  if (difficulty === 'low' || difficulty === 'medium' || difficulty === 'high') return difficulty;
  throw new Error(`Invalid difficulty: ${difficulty}`);
}

function requiredArtifact(toolCall: BridgeToolCall): ArtifactName {
  const artifact = requiredString(toolCall, 'artifact');
  if (isArtifactName(artifact)) return artifact;
  throw new Error(`Invalid artifact: ${artifact}`);
}

function isArtifactName(value: string): value is ArtifactName {
  return [
    'original-task',
    'initial-plan',
    'review',
    'revision-instructions',
    'revised-plan',
    'assistant-explanation',
    'qa-log',
    'decision-log',
    'implementation-log',
    'git-pre-status',
    'git-post-status',
    'git-pre-diff',
    'git-post-diff',
    'test-build-log',
    'final-review',
    'agent-prompts',
    'agent-prompt-preview',
    'final-report',
  ].includes(value);
}

function instructionReply(base: string, instruction?: string): string {
  return instruction ? `${base}: ${instruction}` : base;
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
