import { basename } from 'node:path';

import type { ArtifactStore } from './artifacts.js';
import {
  bridgeToolNamesForInput,
  bridgeToolNamesForTaskStatus,
  type AssistantAdapter,
} from './adapters.js';
import { normalizeWorkflowDifficulty } from './difficulty.js';
import { addProjectToRegistry, type AddProjectInput } from './projectRegistry.js';
import { getDefaultProjectId, renderProjectList, requireProject } from './projects.js';
import type { ProjectKnowledgeService } from './projectKnowledge.js';
import type {
  ArtifactName,
  BridgeAgentDecision,
  BridgeAgentInput,
  BridgeChatMemoryMessage,
  BridgeChatSummary,
  BridgeRetrievedMemory,
  BridgeToolCall,
  BridgeToolName,
  BridgeLiveProcessSnapshot,
  AssistantConfig,
  PendingUserDecision,
  TaskState,
  WorkflowDifficulty,
} from './types.js';
import { isExactDecisionSelection, renderPendingUserDecision, selectedDecisionOption } from './userDecision.js';
import { getActiveProcessSnapshots } from './processRunner.js';
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
  recentMessages?: BridgeChatMemoryMessage[];
  chatSummary?: BridgeChatSummary;
}

type LiveProcessProvider = (taskId: string) => BridgeLiveProcessSnapshot[];
type ToolStateCheck = { ok: true } | { ok: false; reason: string };
type NoOpState = Pick<TaskState, 'status' | 'pendingUserPrompt' | 'pendingUserDecision' | 'implementationFollowup'>;

const FAKE_STATE_CLAIM_PATTERN = /已记录|已推进|已启动|已停止|已进入验收|已验收|已批准|已通过|已接受|已反馈给.*?(workflow|工作流)|我会(记录|反馈|提交|推进|转交)|我来(记录|反馈|提交|推进)|帮你(记录|反馈|提交|推进|转交)|(反馈|提交|转交)给.*?(workflow|工作流)|(马上|现在|立刻|稍后).*(推进|反馈|记录|提交).*(workflow|工作流|流程)|工作流.*?已|流程.*?已推进|已经推进/;

const BRIDGE_TOOL_USER_LABELS: Record<BridgeToolName, string> = {
  reply_to_user: '普通对话回复（reply_to_user，不推进 workflow）',
  create_task: '创建新 task（create_task）',
  choose_difficulty: '选择工作难度（choose_difficulty）',
  approve_plan: '批准计划并启动实现（approve_plan）',
  run_followup: '运行 Final Review follow-up（run_followup）',
  accept_task: '验收当前 task（accept_task）',
  answer_user_direction: '回答 Architect/Reviewer/VibeCodingAssistant-ElonMa 的 pending 问题（answer_user_direction，可回 A/B/C/D 或自由文本）',
  revise_plan: '要求修改计划或返工（revise_plan）',
  stop_task: '停止当前 task（stop_task）',
  ask_task_question: '围绕当前 task 提问（ask_task_question）',
  show_status: '查看当前 task 状态（show_status）',
  show_artifact: '查看 task artifact（show_artifact）',
  switch_project: '切换默认项目（switch_project）',
  add_project: '添加本地项目（add_project）',
  list_projects: '列出项目（list_projects）',
  schedule_task_to_project_chat: '派发 task 到 Project Chat（schedule_task_to_project_chat）',
  create_project_chat: '创建 Project Chat（create_project_chat）',
  create_new_task_from_task_chat: '从当前 task chat 新建后续 task（create_new_task_from_task_chat）',
};

export function isFakeStateClaim(text: string): boolean {
  return FAKE_STATE_CLAIM_PATTERN.test(text);
}

function looksLikeUserDirectionAnswer(input: BridgeAgentInput): boolean {
  if (input.task?.status !== 'waiting_user_direction') return false;
  return isExactDecisionSelection(input.latestUserMessage, input.task.pendingUserDecision, input.task.pendingUserPrompt)
    || looksLikeShortDirectionAnswer(input.latestUserMessage, input.task.pendingUserDecision, input.task.pendingUserPrompt);
}

function looksLikeShortDirectionAnswer(answer: string, decision: PendingUserDecision | undefined, pendingPrompt?: string): boolean {
  if (!decision && !isLegacyPlanArtifactFailurePrompt(pendingPrompt)) return false;
  return /^(?:continue|retry|rerun|restart|go ahead|继续|重试|重新跑|重新规划|再跑一轮|停|停止|stop)$/i.test(answer.trim());
}

function isLegacyPlanArtifactFailurePrompt(prompt: string | undefined): boolean {
  return Boolean(prompt?.includes('Heavy agent did not provide a usable plan artifact'));
}

function looksLikeClarifyingQuestion(text: string): boolean {
  const trimmed = text.trim();
  return /[?？]\s*$/.test(trimmed) && /(吗|么|哪个|哪一个|是否|还是|要不要|需要|请确认|是指|区别|范围|哪种|什么)/.test(trimmed);
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
    private readonly knowledge?: ProjectKnowledgeService,
    private readonly liveProcessProvider: LiveProcessProvider = (taskId) => getActiveProcessSnapshots({ taskId }),
  ) {}

  async handleMessage(request: BridgeAgentRequest): Promise<BridgeAgentTurn> {
    if (!this.assistant.decideBridgeAction) {
      return this.reply('Elon Ma bridge tool-calling is not configured yet, so I did not run any action.');
    }

    const input = await this.buildInput(request);
    const deterministicTurn = await this.tryHandleDeterministicWorkflowCommand(request, input);
    if (deterministicTurn) return deterministicTurn;

    const decision = await this.assistant.decideBridgeAction(input).catch((error: unknown): BridgeAgentDecision => ({
      kind: 'reply',
      text: `Elon Ma could not make a bridge decision: ${errorMessage(error)}`,
    }));

    if (decision.kind === 'reply') return await this.replyGuarded(input, decision.text);
    return this.executeTool(request, input, decision.toolCall);
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
    const observedTaskId = request.activeTask?.taskId ?? request.runningJob?.taskId;
    const liveProcesses = observedTaskId ? this.liveProcessProvider(observedTaskId) : [];
    const memoryProjectId = request.projectChat?.projectId ?? request.activeProjectId;
    const retrievedMemory = await this.retrieveMemory(request.text, memoryProjectId, request.chatSummary?.summary);
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
          generatedArtifacts: Object.keys(task.artifacts) as ArtifactName[],
          ...(task.difficulty ? { difficulty: task.difficulty } : {}),
          ...(task.pendingUserPrompt ? { pendingUserPrompt: task.pendingUserPrompt } : {}),
          ...(task.pendingUserDecision ? { pendingUserDecision: task.pendingUserDecision } : {}),
          ...(task.implementationFollowup ? { implementationFollowup: task.implementationFollowup } : {}),
        },
      } : {}),
      ...(request.runningJob ? {
        runningJob: {
          taskId: request.runningJob.taskId,
          label: request.runningJob.label,
          startedAt: request.runningJob.startedAt,
        },
      } : {}),
      ...(liveProcesses.length > 0 ? { liveProcesses: liveProcesses.map(trimLiveProcessSnapshot) } : {}),
      ...(request.recentMessages && request.recentMessages.length > 0 ? { recentMessages: request.recentMessages } : {}),
      ...(request.chatSummary ? { chatSummary: request.chatSummary } : {}),
      ...(retrievedMemory ? { retrievedMemory } : {}),
      projects: (this.config.projects ?? []).map((project) => ({ id: project.id, name: project.name })),
      config: this.config,
    };
  }

  private async tryHandleDeterministicWorkflowCommand(
    request: BridgeAgentRequest,
    input: BridgeAgentInput,
  ): Promise<BridgeAgentTurn | undefined> {
    if (
      input.task?.status === 'implementation_approved'
      && input.task.implementationFollowup
      && isApproveConfirmation(input.latestUserMessage)
    ) {
      return this.executeTool(request, input, {
        name: 'run_followup',
        arguments: {},
        reasoning: 'deterministic final-review follow-up confirmation',
      });
    }
    return undefined;
  }

  private async retrieveMemory(
    latestUserMessage: string,
    projectId: string | undefined,
    summary: string | undefined,
  ): Promise<BridgeRetrievedMemory | undefined> {
    if (!this.knowledge) return undefined;
    if (!projectId) return undefined;
    const project = (this.config.projects ?? []).find((entry) => entry.id === projectId);
    if (!project) return undefined;
    const query = [latestUserMessage, summary].filter((value): value is string => Boolean(value && value.trim())).join('\n');
    if (!query.trim()) return undefined;
    try {
      const snippets = await this.knowledge.retrieveMemorySnippets(this.config, { projectId, query });
      if (snippets.length === 0) return undefined;
      return {
        query: latestUserMessage,
        projectId,
        snippets: snippets.map((snippet) => ({
          source: snippet.path,
          ...(snippet.heading ? { heading: snippet.heading } : {}),
          text: snippet.text,
          ...(typeof snippet.score === 'number' ? { score: snippet.score } : {}),
        })),
      };
    } catch {
      return undefined;
    }
  }

  private async executeTool(request: BridgeAgentRequest, input: BridgeAgentInput, toolCall: BridgeToolCall): Promise<BridgeAgentTurn> {
    try {
      switch (toolCall.name) {
        case 'reply_to_user':
          return await this.replyGuarded(input, requiredString(toolCall, 'text'));
        case 'create_task':
          return await this.createTask(request, toolCall, false);
        case 'create_new_task_from_task_chat':
          return await this.createTask(request, toolCall, true);
        case 'schedule_task_to_project_chat':
          return await this.scheduleTaskToProjectChat(request, toolCall);
        case 'create_project_chat':
          return this.requestProjectChatCreation(toolCall);
        case 'choose_difficulty': {
          const taskId = this.resolveTaskId(request, toolCall);
          const state = await this.store.loadState(taskId);
          const allowed = this.assertToolAllowedForState(toolCall.name, state);
          if (!allowed.ok) {
            return this.replyNoOp({
              state,
              input,
              intendedAction: describeIntendedToolAction(toolCall.name),
              reason: allowed.reason,
              auditAction: 'guard:state-mismatch',
            });
          }
          const difficulty = requiredDifficulty(toolCall);
          return this.workflowBackground(request, toolCall, 'planning', (taskId) => {
            return this.workflow.reply(taskId, instructionReply(difficulty, optionalString(toolCall, 'instruction')));
          });
        }
        case 'approve_plan': {
          const taskId = this.resolveTaskId(request, toolCall);
          const state = await this.store.loadState(taskId);
          if (state.status === 'waiting_user_direction') {
            return this.answerUserDirection(taskId, optionalString(toolCall, 'instruction') ?? request.text);
          }
          const allowed = this.assertToolAllowedForState(toolCall.name, state);
          if (!allowed.ok) {
            return this.replyNoOp({
              state,
              input,
              intendedAction: describeIntendedToolAction(toolCall.name),
              reason: allowed.reason,
              auditAction: 'guard:state-mismatch',
            });
          }
          return this.workflowBackground(request, toolCall, 'implementing', (taskId) => (
            this.workflow.reply(taskId, instructionReply('approve A', optionalString(toolCall, 'instruction')))
          ));
        }
        case 'run_followup': {
          const taskId = this.resolveTaskId(request, toolCall);
          const state = await this.store.loadState(taskId);
          const allowed = this.assertToolAllowedForState(toolCall.name, state);
          if (!allowed.ok) {
            return this.replyNoOp({
              state,
              input,
              intendedAction: describeIntendedToolAction(toolCall.name),
              reason: allowed.reason,
              auditAction: 'guard:state-mismatch',
            });
          }
          return this.workflowBackground(request, toolCall, 'final-review follow-up', (taskId) => (
            this.workflow.reply(taskId, instructionReply('approve A', optionalString(toolCall, 'instruction')))
          ));
        }
        case 'accept_task': {
          const taskId = this.resolveTaskId(request, toolCall);
          const state = await this.store.loadState(taskId);
          if (state.status === 'waiting_user_direction') {
            return this.answerUserDirection(taskId, optionalString(toolCall, 'instruction') ?? request.text);
          }
          const allowed = this.assertToolAllowedForState(toolCall.name, state);
          if (!allowed.ok) {
            return this.replyNoOp({
              state,
              input,
              intendedAction: describeIntendedToolAction(toolCall.name),
              reason: allowed.reason,
              auditAction: 'guard:state-mismatch',
            });
          }
          const result = await this.workflow.reply(taskId, instructionReply('accept', optionalString(toolCall, 'instruction')));
          return {
            kind: 'reply',
            ...(result.state.status === 'completed' ? { clearActiveTask: { taskId } } : {}),
            ...(result.state.projectId ? { activeProjectId: result.state.projectId } : {}),
            auditAction: 'tool:accept_task',
            messages: [this.workflowMessage(result)],
          };
        }
        case 'answer_user_direction': {
          const taskId = this.resolveTaskId(request, toolCall);
          const state = await this.store.loadState(taskId);
          const allowed = this.assertToolAllowedForState(toolCall.name, state);
          if (!allowed.ok) {
            return this.replyNoOp({
              state,
              input,
              intendedAction: describeIntendedToolAction(toolCall.name),
              reason: allowed.reason,
              auditAction: 'guard:state-mismatch',
            });
          }
          return this.answerUserDirection(taskId, requiredString(toolCall, 'answer'));
        }
        case 'revise_plan': {
          const taskId = this.resolveTaskId(request, toolCall);
          const state = await this.store.loadState(taskId);
          if (state.status === 'waiting_user_direction') {
            return this.answerUserDirection(taskId, optionalString(toolCall, 'instruction') ?? request.text);
          }
          const allowed = this.assertToolAllowedForState(toolCall.name, state);
          if (!allowed.ok) {
            return this.replyNoOp({
              state,
              input,
              intendedAction: describeIntendedToolAction(toolCall.name),
              reason: allowed.reason,
              auditAction: 'guard:state-mismatch',
            });
          }
          const instruction = requiredString(toolCall, 'instruction');
          if (state.status === 'awaiting_user_acceptance') {
            const result = await this.workflow.reply(taskId, `revise C: ${instruction}`);
            return {
              kind: 'reply',
              ...(result.state.projectId ? { activeProjectId: result.state.projectId } : {}),
              auditAction: 'tool:revise_plan',
              messages: [this.workflowMessage(result)],
            };
          }
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

  private async answerUserDirection(
    taskId: string,
    answer: string,
    auditAction = 'tool:answer_user_direction',
  ): Promise<BridgeAgentTurn> {
    const state = await this.store.loadState(taskId);
    if (shouldRunExtraHighDirectionInBackground(state, answer)) {
      const files = filesForState(state);
      return {
        kind: 'background',
        taskId,
        label: extraHighDirectionBackgroundLabel(state, answer),
        auditAction,
        startedMessage: {
          text: renderExtraHighDirectionStartedMessage(state, answer, Boolean(files?.length)),
          ...(files ? { files } : {}),
        },
        run: () => this.workflow.answerUserDirection(taskId, answer),
      };
    }

    const result = await this.workflow.answerUserDirection(taskId, answer);
    return {
      kind: 'reply',
      ...(result.state.projectId ? { activeProjectId: result.state.projectId } : {}),
      auditAction,
      messages: [this.workflowMessage(result)],
    };
  }

  private async replyGuarded(input: BridgeAgentInput, text: string): Promise<BridgeAgentTurn> {
    if (!isFakeStateClaim(text) && input.task?.status === 'waiting_user_direction') {
      if (looksLikeUserDirectionAnswer(input)) {
        return this.answerUserDirection(input.task.taskId, input.latestUserMessage, 'guard:direction-autoanswer');
      }
      if (looksLikeClarifyingQuestion(text)) return this.reply(text);
      return this.replyNoOp({
        state: input.task,
        input,
        intendedAction: '回复用户但不推进 workflow',
        reason: 'task 在 waiting_user_direction，纯文本回复不能推进 workflow，请使用 answer_user_direction',
        auditAction: 'guard:direction-text-blocked',
      });
    }
    if (!isFakeStateClaim(text)) return this.reply(text);
    return this.replyNoOp({
      ...(input.task ? { state: input.task } : {}),
      input,
      intendedAction: inferFakeClaimIntent(text),
      reason: '没有调用 workflow 工具',
      auditAction: 'guard:fake-claim',
    });
  }

  private replyNoOp(options: {
    state?: NoOpState;
    input?: BridgeAgentInput;
    intendedAction: string;
    reason: string;
    auditAction: 'guard:state-mismatch' | 'guard:no-tool' | 'guard:fake-claim' | 'guard:direction-text-blocked';
  }): BridgeAgentTurn {
    const toolNames = options.input
      ? bridgeToolNamesForInput(options.input)
      : options.state
        ? this.bridgeToolNamesForNoOpState(options.state)
        : bridgeToolNamesForInput();
    const actionLines = [...toolNames].map((toolName) => `- ${BRIDGE_TOOL_USER_LABELS[toolName]}`);
    const scopeLine = options.state
      ? `当前阶段（${options.state.status}）下你可以：`
      : '当前可用操作：';
    const pendingPrompt = options.state?.status === 'waiting_user_direction'
      ? (options.state.pendingUserDecision ? renderPendingUserDecision(options.state.pendingUserDecision) : options.state.pendingUserPrompt?.trim())
      : undefined;
    const directionPromptLine = pendingPrompt
      ? `当前 task 正在等你回答下面这个问题，必须用 \`answer_user_direction\` 提交答案，不能用普通文字回复推进 workflow：${
        pendingPrompt.length <= 200 ? pendingPrompt : `${pendingPrompt.slice(0, 197)}...`
      }`
      : undefined;
    // Guard-rejected model text is intentionally not echoed to the user; the raw assistant decision
    // is still available through the normal decision logging path.
    return {
      kind: 'reply',
      auditAction: options.auditAction,
      messages: [{
        text: [
          ...(directionPromptLine ? [directionPromptLine] : []),
          '我没有调用任何 workflow 工具，所以 workflow 实际上没有变化（未推进 workflow）。',
          `原本想做的：${options.intendedAction}`,
          `不能执行的原因：${options.reason}`,
          scopeLine,
          ...actionLines,
        ].join('\n'),
      }],
    };
  }

  private assertToolAllowedForState(toolName: BridgeToolName, state: NoOpState): ToolStateCheck {
    let allowedStatuses: TaskState['status'][] | undefined;
    switch (toolName) {
      case 'choose_difficulty':
        allowedStatuses = ['created', 'awaiting_difficulty_selection'];
        break;
      case 'approve_plan':
        allowedStatuses = ['ready_for_decision'];
        break;
      case 'run_followup':
        if (state.status !== 'implementation_approved') {
          return {
            ok: false,
            reason: 'run_followup can only be used from implementation_approved.',
          };
        }
        if (!state.implementationFollowup) {
          return {
            ok: false,
            reason: 'Current task has no active final-review follow-up scope.',
          };
        }
        return { ok: true };
      case 'accept_task':
        allowedStatuses = ['awaiting_user_acceptance'];
        break;
      case 'answer_user_direction':
        allowedStatuses = ['waiting_user_direction'];
        break;
      case 'revise_plan':
        allowedStatuses = ['ready_for_decision', 'waiting_user_direction', 'awaiting_user_acceptance'];
        break;
      default:
        return { ok: true };
    }
    if (allowedStatuses.includes(state.status)) return { ok: true };
    return {
      ok: false,
      reason: `当前 task 状态是 ${state.status}，这个 workflow 动作只能在 ${allowedStatuses.join(', ')} 阶段使用。`,
    };
  }

  private bridgeToolNamesForNoOpState(state: NoOpState): Set<BridgeToolName> {
    const toolNames = new Set(bridgeToolNamesForTaskStatus(state.status));
    if (state.status === 'implementation_approved' && state.implementationFollowup) {
      toolNames.add('run_followup');
    }
    return toolNames;
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
    const liveProcesses = this.liveProcessProvider(taskId);
    return this.reply(renderBridgeStatus(state, running?.label, liveProcesses));
  }

  private async showArtifact(request: BridgeAgentRequest, toolCall: BridgeToolCall): Promise<BridgeAgentTurn> {
    const taskId = this.resolveTaskId(request, toolCall);
    const artifact = requiredArtifact(toolCall);
    const stateBeforeRead = await this.store.loadState(taskId);
    if (artifact !== 'agent-prompt-preview' && !stateBeforeRead.artifacts[artifact]) {
      return this.reply(renderMissingArtifactReply(
        stateBeforeRead,
        artifact,
        request.runningJob?.taskId === taskId ? request.runningJob.label : undefined,
      ));
    }
    let content: string;
    try {
      content = await this.workflow.showArtifact(taskId, artifact);
    } catch (error) {
      if (isMissingArtifactError(error)) {
        return this.reply(renderMissingArtifactReply(
          stateBeforeRead,
          artifact,
          request.runningJob?.taskId === taskId ? request.runningJob.label : undefined,
        ));
      }
      throw error;
    }
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
        '请选择工作难度：low、medium、high 或 extra high。',
      ].join('\n'),
    });
  }

  private workflowMessage(result: WorkflowResult): BridgeOutboundMessage {
    const files = filesForState(result.state);
    const waitingPrompt = result.state.status === 'waiting_user_direction' ? result.state.pendingUserPrompt?.trim() : undefined;
    const text = waitingPrompt && !result.message.includes(waitingPrompt)
      ? `${result.message}\n\n${waitingPrompt}`
      : result.message;
    return {
      text,
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
  if (isExtraHighPlanningPause(state)) artifactNames.push('revised-plan', 'plan-rounds-log', 'blocker-ledger');
  if (state.status === 'awaiting_user_acceptance') artifactNames.push('final-review', 'test-build-log', 'deferred-issues');
  if (state.status === 'completed') artifactNames.push('final-report');
  const files = artifactNames
    .map((artifact) => state.artifacts[artifact])
    .filter((path): path is string => Boolean(path))
    .map((path) => ({ path, name: basename(path) }));
  return files.length > 0 ? files : undefined;
}

function isExtraHighPlanningPause(state: TaskState): boolean {
  return state.status === 'waiting_user_direction'
    && state.pendingUserDecision?.source === 'extra_high_planning';
}

function shouldRunExtraHighDirectionInBackground(state: TaskState, answer: string): boolean {
  if (!isExtraHighPlanningPause(state)) return false;
  const trimmed = answer.trim();
  if (!trimmed) return false;
  const selected = selectedDecisionOption(state.pendingUserDecision, trimmed);
  if (/^stop$/i.test(trimmed)) return false;
  if (!selected && /^(?:approve|approved|approve\s+a|yes|y|同意|批准)$/i.test(trimmed)) return false;
  return true;
}

function extraHighDirectionBackgroundLabel(state: TaskState, answer: string): string {
  const selected = selectedDecisionOption(state.pendingUserDecision, answer);
  if (isExtraHighExecuteCurrentPlanDirection(answer, selected?.id)) return 'extra-high implementing';
  return selected?.id === 'B' ? 'extra-high replanning' : 'extra-high planning';
}

function renderExtraHighDirectionStartedMessage(state: TaskState, answer: string, hasFiles: boolean): string {
  const selected = selectedDecisionOption(state.pendingUserDecision, answer);
  const executeCurrentPlan = isExtraHighExecuteCurrentPlanDirection(answer, selected?.id);
  const firstLine = selected?.id === 'B'
    ? '收到，我重新开始 Extra High planning。'
    : executeCurrentPlan
      ? '收到，我会直接执行当前 Extra High plan。'
    : selected?.id === 'A'
      ? '收到，我继续 Extra High planning 一轮。'
      : '收到，我按你的方向继续 Extra High planning 一轮。';
  const round = state.reviewerRunCount || state.revisionRound;
  return [
    firstLine,
    round ? `当前停在第 ${round} 轮 reviewer 仍有 blocking findings。` : undefined,
    hasFiles
      ? '我先把当前 revised-plan 和 plan-rounds-log 附上，方便你看到现在的 plan 不是黑盒。'
      : '当前状态里还没有可发送的 revised-plan 或 plan-rounds-log；这一轮完成后会随结果发送。',
    executeCurrentPlan
      ? '执行完成后我会把实现、测试和最终 review 结果发到这里。'
      : '这一轮完成后我会把新的结果发到这里；如果仍有 blocking findings，会再次先问你要不要继续。',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function isExtraHighExecuteCurrentPlanDirection(answer: string, selectedOptionId?: string): boolean {
  if (selectedOptionId === 'C') return true;
  if (selectedOptionId) return false;
  const normalized = answer.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (normalized.length > 160) return false;
  const compact = normalized.replace(/\s+/g, '');
  return /(?:execute|implement|run|use|approve).*(?:current|this|latest).*(?:plan|方案)/i.test(normalized)
    || /(?:current|this|latest).*(?:plan|方案).*(?:execute|implement|run|use|approve)/i.test(normalized)
    || /(?:直接|现在|马上)?(?:执行|实施|实现|批准|照做|按).*(?:当前|这个|這個|这版|最新版|latest)?(?:plan|方案|计划|計劃)/.test(compact)
    || /(?:按|照)(?:当前|这个|這個|这版|最新版)?(?:plan|方案|计划|計劃)(?:执行|做|实施|实现)/.test(compact);
}

function trimLiveProcessSnapshot(snapshot: BridgeLiveProcessSnapshot): BridgeLiveProcessSnapshot {
  const next: BridgeLiveProcessSnapshot = { ...snapshot };
  if (snapshot.stdoutTail) {
    next.stdoutTail = shorten(lastNonEmptyLines(snapshot.stdoutTail, 12), 1600);
  } else {
    delete next.stdoutTail;
  }
  if (snapshot.stderrTail) {
    next.stderrTail = shorten(lastNonEmptyLines(snapshot.stderrTail, 12), 1600);
  } else {
    delete next.stderrTail;
  }
  return next;
}

function renderBridgeStatus(state: TaskState, runningLabel?: string, liveProcesses: BridgeLiveProcessSnapshot[] = []): string {
  const liveLines = renderLiveProcessSummary(liveProcesses);
  const executionLines = renderExecutionProgress(state);
  const missingBackgroundWorker = isBackgroundWorkflowState(state.status) && !runningLabel && liveProcesses.length === 0;
  const pendingPrompt = state.status === 'waiting_user_direction' ? state.pendingUserPrompt?.trim() : undefined;
  const lines = [
    `当前任务：${state.title}`,
    `阶段：${bridgeStageName(state.status)}`,
    `状态码：${state.status}`,
    state.difficulty ? `难度：${state.difficulty}` : undefined,
    runningLabel ? `后台任务：${runningLabel}` : undefined,
    pendingPrompt ? '' : undefined,
    pendingPrompt ? '待你决定：' : undefined,
    pendingPrompt,
    missingBackgroundWorker
      ? '后台任务未运行：可能是上次 VibeCodingAssistant-ElonMa 重启或进程中断后的残留状态；当前没有可恢复的 worker。'
      : undefined,
    ...executionLines,
    ...(liveLines.length > 0 ? ['', '实时观察：', ...liveLines] : []),
    '',
    bridgeNextStep(state.status, missingBackgroundWorker),
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

function isBackgroundWorkflowState(status: TaskState['status']): boolean {
  return [
    'planning',
    'task_artifacts_persisting',
    'implementing',
    'execution_queue_ready',
    'execution_unit_implementing',
    'execution_unit_testing',
    'execution_unit_result_recording',
    'next_execution_unit_or_all_done',
    'implemented',
    'final_reviewing',
    'final_review_routing',
    'task_recording',
  ].includes(status);
}

function renderExecutionProgress(state: TaskState): string[] {
  if (state.executionQueue.length === 0) return [];
  const currentIndex = typeof state.currentExecutionIndex === 'number'
    ? state.currentExecutionIndex
    : state.executionQueue.findIndex((unit) => unit.status === 'In Progress');
  const current = currentIndex >= 0 ? state.executionQueue[currentIndex] : undefined;
  const done = state.executionQueue.filter((unit) => unit.status === 'Done').length;
  const total = state.executionQueue.length;
  return [
    `执行单元：${done}/${total} 已完成`,
    current ? `当前单元：${current.index}/${total} ${current.name}（${current.status}）` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function renderLiveProcessSummary(processes: BridgeLiveProcessSnapshot[]): string[] {
  return processes.flatMap((process, index) => {
    const roleName = [process.role, process.profileName].filter(Boolean).join(':');
    const name = process.label ?? (roleName || process.command);
    const output = process.stdoutTail || process.stderrTail;
    return [
      `- worker ${index + 1}: ${name}${process.pid ? `, pid ${process.pid}` : ''}, 已运行 ${formatElapsed(process.elapsedMs)}`,
      `  cwd: ${process.cwd}`,
      output ? `  最近输出：${shorten(lastNonEmptyLines(output, 8), 900)}` : '  最近输出：还没有可见 stdout/stderr；这通常表示 worker 正在内部思考或工具还没吐日志。',
    ];
  });
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function lastNonEmptyLines(text: string, maxLines: number): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines)
    .join('\n');
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

function bridgeNextStep(status: TaskState['status'], missingBackgroundWorker = false): string {
  if (missingBackgroundWorker) {
    return '下一步：请查看已有 artifacts 判断进度，或明确说 stop 停止任务；如果要重做，可以用 restart 重新开始。';
  }
  switch (status) {
    case 'awaiting_difficulty_selection':
    case 'created':
      return '下一步：选 low / medium / high / extra high。你也可以问我为什么要选难度。';
    case 'ready_for_decision':
      return '下一步：如果计划没问题，可以说 approve；如果要改，直接说改哪里。';
    case 'waiting_user_direction':
      return '下一步：回答上面的待决定问题（answer_user_direction）。如果还需要时间或要补充信息，可以先继续提问。';
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

function renderMissingArtifactReply(state: TaskState, artifact: ArtifactName, runningLabel?: string): string {
  return [
    `不是权限问题，是 ${artifact}.md 现在还没生成。`,
    `当前阶段：${bridgeStageName(state.status)} (${state.status})`,
    runningLabel ? `后台正在运行：${runningLabel}` : undefined,
    '',
    missingArtifactHint(artifact, state.status),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function missingArtifactHint(artifact: ArtifactName, status: TaskState['status']): string {
  if (artifact === 'implementation-log') {
    return ['implementation_approved', 'implementing', 'execution_unit_implementing'].includes(status)
      ? 'Developer 还在执行；implementation-log 要等这一段实现结束后才会落盘。你可以问“当前状态”确认它是不是还在跑。'
      : '这个 task 还没有产生 implementation-log；可能还没进入实现，或者实现没有成功产生日志。';
  }
  if (artifact === 'test-build-log') {
    return 'test-build-log 要等实现后的验证阶段结束才会生成。';
  }
  if (artifact === 'final-review') {
    return 'final-review 要等实现和验证结束后才会生成。';
  }
  if (artifact === 'final-report') {
    return 'final-report 要等你最终验收后才会生成。';
  }
  return '这个 artifact 还没在当前 task 中生成。';
}

function isMissingArtifactError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /ENOENT|no such file or directory/i.test(error.message);
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
  const normalized = normalizeWorkflowDifficulty(difficulty);
  if (normalized) return normalized;
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
    'plan-rounds-log',
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
  ].includes(value);
}

function instructionReply(base: string, instruction?: string): string {
  return instruction ? `${base}: ${instruction}` : base;
}

function isApproveConfirmation(input: string): boolean {
  return /^(?:approve A|approve|approved|A|yes|y)$/i.test(input.trim().replace(/\s+/g, ' '));
}

function describeIntendedToolAction(toolName: BridgeToolName): string {
  switch (toolName) {
    case 'choose_difficulty':
      return '选择工作难度并开始规划';
    case 'approve_plan':
      return '批准计划并启动实现';
    case 'run_followup':
      return '运行 Final Review follow-up';
    case 'accept_task':
      return '验收当前 task';
    case 'answer_user_direction':
      return '提交用户对 pending 问题的回答';
    case 'revise_plan':
      return '要求修改计划或返工';
    default:
      return BRIDGE_TOOL_USER_LABELS[toolName];
  }
}

function inferFakeClaimIntent(text: string): string {
  if (/已停止/.test(text)) return '停止当前 task';
  if (/已进入验收|已验收|已接受/.test(text)) return '验收当前 task 或进入验收阶段';
  if (/已批准|已通过/.test(text)) return '批准计划或验收结果';
  if (/已启动/.test(text)) return '启动后台 workflow';
  if (/已记录|已反馈给.*?(workflow|工作流)|我会(记录|反馈|提交|推进|转交)|我来(记录|反馈|提交|推进)|帮你(记录|反馈|提交|推进|转交)|(反馈|提交|转交)给.*?(workflow|工作流)|(马上|现在|立刻|稍后).*(推进|反馈|记录|提交).*(workflow|工作流|流程)/.test(text)) return '记录用户选择并反馈给 workflow';
  if (/流程.*?已推进|已经推进|已推进/.test(text)) return '推进 workflow';
  return '执行一个会改变 workflow 状态的动作';
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
