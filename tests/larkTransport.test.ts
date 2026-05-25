import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, AssistantAdapter } from '../src/adapters.js';
import { BridgeAgentService } from '../src/bridgeAgent.js';
import { LarkTransport, type LarkClientPort, type LarkIncomingMessage } from '../src/larkBridge.js';
import { bindTaskToProjectChat, LarkBridgeStateStore, registerProjectChat } from '../src/larkBridgeState.js';
import type {
  BridgeAgentDecision,
  BridgeAgentInput,
  ControlChatResult,
  IntentResult,
  AssistantConfig,
  AssistantRouteResult,
  AssistantTextResult,
  OrchestratorDecision,
  PlanResult,
  WorkflowDifficulty,
} from '../src/types.js';
import { WorkflowService, type WorkflowResult } from '../src/workflow.js';

class FakeLarkClient implements LarkClientPort {
  sentTexts: { chatId: string; text: string }[] = [];
  sentFiles: { chatId: string; path: string; name: string }[] = [];
  createdChats: { name: string; memberOpenIds: string[] }[] = [];

  async start(): Promise<void> {}

  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }

  async sendFile(chatId: string, file: { path: string; name: string }): Promise<void> {
    this.sentFiles.push({ chatId, ...file });
  }

  async createTaskChat(input: { name: string; memberOpenIds: string[] }): Promise<string> {
    this.createdChats.push(input);
    return `task-chat-${this.createdChats.length}`;
  }
}

class FakeAssistant implements AssistantAdapter {
  decisions: BridgeAgentDecision[] = [];
  bridgeInputs: BridgeAgentInput[] = [];

  async decideBridgeAction(input: BridgeAgentInput): Promise<BridgeAgentDecision> {
    this.bridgeInputs.push(input);
    return this.decisions.shift() ?? { kind: 'reply', text: `agent reply: ${input.latestUserMessage}` };
  }

  async decideNextAction(): Promise<OrchestratorDecision> {
    return { action: 'wait_for_user', reason: 'unused', confidence: 1 };
  }

  async classifyIntent(): Promise<IntentResult> {
    return { intent: 'unknown', confidence: 0.1, requiresClarification: true, userFacingInterpretation: 'unused' };
  }

  async composeReply(input: { rawMessage: string }): Promise<{ text: string }> {
    return { text: input.rawMessage };
  }

  async createRevisionInstructions(): Promise<AssistantTextResult> {
    return { markdown: 'instructions', needsUserDecision: false };
  }

  async explainRevisedPlan(): Promise<AssistantTextResult> {
    return { markdown: 'explanation', needsUserDecision: false };
  }

  async answerQuestion(input: { question: string }): Promise<string> {
    return `answer: ${input.question}`;
  }

  async interpretAmbiguousReply(input: { reply: string }): Promise<string> {
    return `confirm: ${input.reply}`;
  }

  async handleControlChat(): Promise<ControlChatResult> {
    return { kind: 'answer', markdown: 'unused' };
  }

  async routeAfterFinalReview(): Promise<AssistantRouteResult> {
    return { route: 'complete', reason: 'ok' };
  }
}

class FakeHeavyAgents implements HeavyAgentAdapter {
  async createInitialPlan(input: { difficulty: WorkflowDifficulty }): Promise<PlanResult> {
    return { markdown: `plan ${input.difficulty}`, verificationCommands: [] };
  }

  async reviewPlan(): Promise<{ markdown: string }> {
    return { markdown: 'review' };
  }

  async revisePlan(): Promise<PlanResult> {
    return { markdown: 'revised', verificationCommands: [] };
  }

  async implement(): Promise<{ markdown: string; changedFiles: string[] }> {
    return { markdown: 'implemented', changedFiles: [] };
  }

  async finalReview(): Promise<{ markdown: string; passed: boolean }> {
    return { markdown: 'final', passed: true };
  }
}

function makeConfig(targetDir: string): AssistantConfig {
  return {
    workspace: { targetDir },
    defaultProjectId: 'default',
    projects: [{
      id: 'default',
      name: 'Default',
      targetDir,
      docsDir: 'project-docs/default',
      alwaysRead: [],
    }],
    artifactsDir: 'logs/ai-workflow',
    lark: {
      platform: 'lark',
      appIdEnv: 'LARK_APP_ID',
      appSecretEnv: 'LARK_APP_SECRET',
      allowedOpenIds: ['user-open-id'],
      taskMemberOpenIds: ['owner-open-id'],
      controlChatIds: [],
    },
    maxRevisionRounds: 3,
    workflowRoles: {
      assistant: 'assistant',
      low: { architect: 'planner', planReviewer: 'planner', developer: 'implementer', finalReviewer: 'implementer' },
      medium: { architect: 'planner', planReviewer: 'reviewer', developer: 'implementer', finalReviewer: 'finalReviewer' },
      high: { architect: 'reviewer', planReviewer: 'planner', developer: 'implementer', finalReviewer: 'finalReviewer' },
    },
    profiles: {
      assistant: { kind: 'deepseek' },
      planner: { kind: 'codex' },
      reviewer: { kind: 'claude' },
      implementer: { kind: 'codex' },
      finalReviewer: { kind: 'claude' },
    },
    verification: { allowlist: [] },
  };
}

async function makeHarness(): Promise<{
  root: string;
  targetDir: string;
  store: ArtifactStore;
  workflow: WorkflowService;
  assistant: FakeAssistant;
  client: FakeLarkClient;
  stateStore: LarkBridgeStateStore;
  transport: LarkTransport;
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  const workflow = new WorkflowService(store, config, assistant, new FakeHeavyAgents(), { executeVerification: false });
  const agent = new BridgeAgentService(workflow, store, assistant, config);
  const client = new FakeLarkClient();
  const stateStore = new LarkBridgeStateStore(root, config);
  return {
    root,
    targetDir,
    store,
    workflow,
    assistant,
    client,
    stateStore,
    transport: new LarkTransport(config, store, client, agent, stateStore),
  };
}

function message(overrides: Partial<LarkIncomingMessage>): LarkIncomingMessage {
  return {
    eventId: 'event-1',
    messageId: 'message-1',
    chatId: 'control-chat',
    senderOpenId: 'user-open-id',
    text: 'hello',
    ...overrides,
  };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rm(path, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }));
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path, 'utf8');
  return content.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function bindTask(harness: Awaited<ReturnType<typeof makeHarness>>, chatId = 'task-chat-existing'): Promise<string> {
  const created = await harness.workflow.createTask({ title: 'Existing task', task: 'Build the chat transport.' });
  const state = await harness.stateStore.load();
  bindTaskToProjectChat(state, chatId, {
    taskId: created.state.taskId,
    title: created.state.title,
    projectId: 'default',
    chatName: 'Assistant - [Default] #1',
  });
  await harness.stateStore.save(state);
  return created.state.taskId;
}

async function registerIdleProjectChat(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  chatId = 'project-chat-idle',
): Promise<void> {
  const state = await harness.stateStore.load();
  registerProjectChat(state, {
    chatId,
    projectId: 'default',
    name: 'Assistant - [Default] #1',
  });
  await harness.stateStore.save(state);
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < 1000) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

describe('LarkTransport', () => {
  it('rejects unauthorized senders before DeepSeek', async () => {
    const harness = await makeHarness();
    try {
      await harness.transport.handleMessage(message({ senderOpenId: 'stranger' }));

      expect(harness.assistant.bridgeInputs).toHaveLength(0);
      expect(harness.client.sentTexts).toHaveLength(0);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('deduplicates event ids before invoking DeepSeek twice', async () => {
    const harness = await makeHarness();
    try {
      await harness.transport.handleMessage(message({ eventId: 'same-event', text: 'hello' }));
      await harness.transport.handleMessage(message({ eventId: 'same-event', text: 'hello again' }));

      expect(harness.assistant.bridgeInputs).toHaveLength(1);
      expect(harness.client.sentTexts).toHaveLength(1);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('drops legacy bridge state fields when loading state', async () => {
    const harness = await makeHarness();
    try {
      await mkdir(join(harness.root, 'logs', 'ai-workflow'), { recursive: true });
      await writeFile(harness.stateStore.statePath(), JSON.stringify({
        pairingCode: '123456',
        pairedOpenIds: ['old-user'],
        pendingProposalsByChatId: { chat: { title: 'old' } },
        notifiedStatusByTaskId: { task: 'ready_for_decision' },
        lastReminderHashByTaskId: { task: 'hash' },
        activeProjectIdByChatId: {},
        bindingsByChatId: {
          'legacy-task-chat': {
            taskId: 'TASK-LEGACY',
            title: 'Legacy task',
            createdAt: '2026-05-01T00:00:00.000Z',
            projectId: 'default',
          },
        },
        runningJobsByTaskId: {},
        processedEventIds: ['event'],
      }), 'utf8');

      await harness.stateStore.load();

      const saved = JSON.parse(await readFile(harness.stateStore.statePath(), 'utf8')) as Record<string, unknown>;
      expect(saved.pairingCode).toBeUndefined();
      expect(saved.pairedOpenIds).toBeUndefined();
      expect(saved.pendingProposalsByChatId).toBeUndefined();
      expect(saved.notifiedStatusByTaskId).toBeUndefined();
      expect(saved.lastReminderHashByTaskId).toBeUndefined();
      expect(saved.projectChatsByChatId).toMatchObject({
        'legacy-task-chat': { projectId: 'default', activeTaskId: 'TASK-LEGACY' },
      });
      expect(saved.activeTaskByChatId).toMatchObject({
        'legacy-task-chat': { taskId: 'TASK-LEGACY', title: 'Legacy task' },
      });
      expect(saved.processedEventIds).toEqual(['event']);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('passes bound task chat messages directly to the bridge agent', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await bindTask(harness);

      await harness.transport.handleMessage(message({
        eventId: 'bound-message',
        chatId: 'task-chat-existing',
        text: '为什么要选难度',
      }));

      expect(harness.assistant.bridgeInputs[0]?.chat.boundTaskId).toBe(taskId);
      expect(harness.assistant.bridgeInputs[0]?.latestUserMessage).toBe('为什么要选难度');
      expect(harness.client.sentTexts.at(-1)?.text).toContain('agent reply');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('removes stale task chat bindings before handing the message to DeepSeek', async () => {
    const harness = await makeHarness();
    try {
      const state = await harness.stateStore.load();
      bindTaskToProjectChat(state, 'old-task-chat', {
        taskId: 'deleted-task',
        title: 'Deleted task',
        projectId: 'default',
        chatName: 'Assistant - [Default] #1',
      });
      state.runningJobsByTaskId['deleted-task'] = {
        taskId: 'deleted-task',
        label: '规划中',
        startedAt: new Date().toISOString(),
      };
      await harness.stateStore.save(state);

      await harness.transport.handleMessage(message({
        eventId: 'stale-binding',
        chatId: 'old-task-chat',
        text: '重新开始一个任务',
      }));

      expect(harness.assistant.bridgeInputs[0]?.chat.boundTaskId).toBeUndefined();
      const saved = await harness.stateStore.load();
      expect(saved.projectChatsByChatId['old-task-chat']).toBeTruthy();
      expect(saved.activeTaskByChatId['old-task-chat']).toBeUndefined();
      expect(saved.runningJobsByTaskId['deleted-task']).toBeUndefined();
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('passes running task messages to DeepSeek instead of blocking in transport', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await bindTask(harness);
      const state = await harness.stateStore.load();
      state.runningJobsByTaskId[taskId] = { taskId, label: '规划中', startedAt: new Date().toISOString() };
      await harness.stateStore.save(state);

      await harness.transport.handleMessage(message({
        eventId: 'running-question',
        chatId: 'task-chat-existing',
        text: '现在在干嘛',
      }));

      expect(harness.assistant.bridgeInputs[0]?.runningJob?.label).toBe('规划中');
      expect(harness.client.sentTexts.at(-1)?.text).toContain('agent reply');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('clears orphaned running jobs on start without changing task state', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await bindTask(harness);
      const taskState = await harness.store.loadState(taskId);
      await harness.store.saveState({
        ...taskState,
        status: 'execution_unit_implementing',
        difficulty: 'low',
        currentExecutionIndex: 0,
        executionQueue: [{
          index: 1,
          slug: 'main',
          name: 'Main',
          status: 'In Progress',
          fileName: '01-main.md',
        }],
        updatedAt: new Date().toISOString(),
      });
      const state = await harness.stateStore.load();
      state.runningJobsByTaskId[taskId] = {
        taskId,
        label: 'implementing',
        startedAt: '2026-05-25T05:12:40.983Z',
      };
      await harness.stateStore.save(state);

      await harness.transport.start();

      const saved = await harness.stateStore.load();
      expect(saved.runningJobsByTaskId[taskId]).toBeUndefined();
      expect(saved.activeTaskByChatId['task-chat-existing']?.taskId).toBe(taskId);
      expect((await harness.store.loadState(taskId)).status).toBe('execution_unit_implementing');
      expect(harness.client.sentTexts.at(-1)).toMatchObject({ chatId: 'task-chat-existing' });
      const text = harness.client.sentTexts.at(-1)?.text ?? '';
      expect(text).toContain('后台任务标记');
      expect(text).toContain('没有对应 worker');
      expect(text).toContain('任务本身状态没有自动修改');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('hard-stops an obvious cancel command and clears the running marker', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await bindTask(harness);
      const state = await harness.stateStore.load();
      state.runningJobsByTaskId[taskId] = { taskId, label: '实现中', startedAt: new Date().toISOString() };
      await harness.stateStore.save(state);

      await harness.transport.handleMessage(message({
        eventId: 'hard-stop',
        chatId: 'task-chat-existing',
        text: '我想取消这个任务',
      }));

      expect(harness.assistant.bridgeInputs).toHaveLength(0);
      expect((await harness.store.loadState(taskId)).status).toBe('stopped');
      expect((await harness.stateStore.load()).runningJobsByTaskId[taskId]).toBeUndefined();
      expect(harness.client.sentTexts.at(-1)?.text).toContain('Task stopped');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('creates a task only when DeepSeek chooses the create_task tool', async () => {
    const harness = await makeHarness();
    try {
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'create_task',
          arguments: { prompt: 'Build the Lark transport.', title: 'Lark transport' },
        },
      });

      await harness.transport.handleMessage(message({ eventId: 'create-task', text: 'Build the Lark transport.' }));

      expect(harness.client.createdChats).toHaveLength(1);
      expect(harness.client.createdChats[0]?.name).toBe('Assistant - [Default] #1');
      const state = await harness.stateStore.load();
      const projectChat = state.projectChatsByChatId['task-chat-1'];
      const activeTask = state.activeTaskByChatId['task-chat-1'];
      expect(projectChat?.projectId).toBe('default');
      expect(activeTask?.title).toBe('Lark transport');
      expect(harness.client.sentTexts.at(-1)?.text).toContain('请选择工作难度');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('creates a new task inside an idle Project Chat without creating another group', async () => {
    const harness = await makeHarness();
    try {
      await registerIdleProjectChat(harness, 'project-chat-idle');
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'create_task',
          arguments: { prompt: 'Build in this project chat.', title: 'Same group task' },
        },
      });

      await harness.transport.handleMessage(message({
        eventId: 'idle-project-create',
        chatId: 'project-chat-idle',
        text: 'Build in this project chat.',
      }));

      expect(harness.client.createdChats).toHaveLength(0);
      const state = await harness.stateStore.load();
      expect(state.projectChatsByChatId['project-chat-idle']?.projectId).toBe('default');
      expect(state.activeTaskByChatId['project-chat-idle']?.title).toBe('Same group task');
      expect(harness.assistant.bridgeInputs[0]?.chat.chatKind).toBe('project');
      expect(harness.assistant.bridgeInputs[0]?.chat.projectChat?.hasActiveTask).toBe(false);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('releases completed active tasks but keeps the Project Chat registration', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await bindTask(harness, 'project-chat-completed');
      await harness.workflow.reply(taskId, 'stop');

      await harness.transport.handleMessage(message({
        eventId: 'completed-project-chat',
        chatId: 'project-chat-completed',
        text: 'next thing?',
      }));

      const state = await harness.stateStore.load();
      expect(state.projectChatsByChatId['project-chat-completed']).toBeTruthy();
      expect(state.activeTaskByChatId['project-chat-completed']).toBeUndefined();
      expect(harness.assistant.bridgeInputs[0]?.chat.chatKind).toBe('project');
      expect(harness.assistant.bridgeInputs[0]?.chat.boundTaskId).toBeUndefined();
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('dispatches a Control Chat task prompt to an idle Project Chat', async () => {
    const harness = await makeHarness();
    try {
      await registerIdleProjectChat(harness, 'project-chat-idle');
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'schedule_task_to_project_chat',
          arguments: { projectId: 'default', prompt: 'Dispatch this task.', title: 'Dispatched task' },
        },
      });

      await harness.transport.handleMessage(message({
        eventId: 'dispatch-task',
        chatId: 'control-chat',
        text: 'Default project: Dispatch this task.',
      }));

      const state = await harness.stateStore.load();
      expect(state.activeTaskByChatId['project-chat-idle']?.title).toBe('Dispatched task');
      expect(harness.client.createdChats).toHaveLength(0);
      expect(harness.client.sentTexts.some((entry) => entry.chatId === 'project-chat-idle' && entry.text.includes('Dispatched task'))).toBe(true);
      expect(harness.client.sentTexts.some((entry) => entry.chatId === 'control-chat' && entry.text.includes('已把任务'))).toBe(true);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('asks before creating another Project Chat when all groups are busy', async () => {
    const harness = await makeHarness();
    try {
      await bindTask(harness, 'project-chat-busy');
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'schedule_task_to_project_chat',
          arguments: { projectId: 'default', prompt: 'Another task.', title: 'Blocked dispatch' },
        },
      });

      await harness.transport.handleMessage(message({
        eventId: 'dispatch-busy',
        chatId: 'control-chat',
        text: 'Default project: Another task.',
      }));

      expect(harness.client.createdChats).toHaveLength(0);
      expect(harness.client.sentTexts.at(-1)?.chatId).toBe('control-chat');
      expect(harness.client.sentTexts.at(-1)?.text).toContain('没有空闲');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('creates and registers an empty Project Chat on explicit request', async () => {
    const harness = await makeHarness();
    try {
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'create_project_chat',
          arguments: { projectId: 'default' },
        },
      });

      await harness.transport.handleMessage(message({
        eventId: 'create-project-chat',
        chatId: 'control-chat',
        text: 'Create another Project Chat for Default.',
      }));

      expect(harness.client.createdChats[0]?.name).toBe('Assistant - [Default] #1');
      const state = await harness.stateStore.load();
      expect(state.projectChatsByChatId['task-chat-1']?.projectId).toBe('default');
      expect(state.activeTaskByChatId['task-chat-1']).toBeUndefined();
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('starts workflow mutations as background jobs from tool calls', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await bindTask(harness);
      await harness.workflow.planTask(taskId);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'choose_difficulty',
          arguments: { difficulty: 'low', instruction: 'use my original prompt' },
        },
      });

      await harness.transport.handleMessage(message({
        eventId: 'choose-low',
        chatId: 'task-chat-existing',
        text: 'low，就按我原 prompt 做',
      }));

      expect((await harness.stateStore.load()).runningJobsByTaskId[taskId]?.label).toBe('planning');
      await waitFor(async () => {
        expect((await harness.stateStore.load()).runningJobsByTaskId[taskId]).toBeUndefined();
        expect((await harness.store.loadState(taskId)).difficulty).toBe('low');
      });
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('writes minimal audit for inbound and outbound messages', async () => {
    const harness = await makeHarness();
    try {
      await harness.transport.handleMessage(message({ eventId: 'audit-event', text: 'hello audit' }));

      const inbound = await readJsonl(join(harness.root, 'logs', 'ai-workflow', 'lark-inbound.jsonl'));
      expect(inbound.some((entry) => entry.eventId === 'audit-event' && entry.outcome === 'received')).toBe(true);

      const outbound = await readJsonl(join(harness.root, 'logs', 'ai-workflow', 'lark-outbound.jsonl'));
      expect(outbound.some((entry) => entry.kind === 'text' && entry.success === true)).toBe(true);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('records inbound user messages and outbound assistant replies into chat memory', async () => {
    const harness = await makeHarness();
    try {
      harness.assistant.decisions.push({ kind: 'reply', text: 'first reply' });
      await harness.transport.handleMessage(message({ eventId: 'mem-1', chatId: 'control-chat', text: 'first user message' }));

      harness.assistant.decisions.push({ kind: 'reply', text: 'second reply' });
      await harness.transport.handleMessage(message({ eventId: 'mem-2', chatId: 'control-chat', text: 'second user message' }));

      const state = await harness.stateStore.load();
      const messages = state.recentMessagesByChatId['control-chat'] ?? [];
      const summary = messages.map((entry) => `${entry.role}:${entry.text}`);
      expect(summary).toEqual([
        'user:first user message',
        'assistant:first reply',
        'user:second user message',
        'assistant:second reply',
      ]);
      expect(messages[0]?.eventId).toBe('mem-1');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('passes prior recent messages and summary to decideBridgeAction without including the latest one', async () => {
    const harness = await makeHarness();
    try {
      const state = await harness.stateStore.load();
      const { appendRecentMessage, setChatSummary } = await import('../src/larkBridgeState.js');
      appendRecentMessage(state, 'control-chat', {
        role: 'assistant',
        text: '要为 IReader 创建 Project Chat 吗？',
        at: '2025-01-01T00:00:00Z',
      });
      setChatSummary(state, 'control-chat', {
        summary: '用户正在为 IReader 配置 Project Chat',
        messageCountCovered: 4,
        updatedAt: '2025-01-01T00:00:00Z',
      });
      await harness.stateStore.save(state);

      harness.assistant.decisions.push({ kind: 'reply', text: '好的，正在为 IReader 创建 Project Chat。' });
      await harness.transport.handleMessage(message({ eventId: 'context-1', chatId: 'control-chat', text: '现在创建吧' }));

      const captured = harness.assistant.bridgeInputs[0];
      expect(captured?.latestUserMessage).toBe('现在创建吧');
      expect(captured?.recentMessages?.length).toBe(1);
      expect(captured?.recentMessages?.[0]?.text).toBe('要为 IReader 创建 Project Chat 吗？');
      expect(captured?.recentMessages?.some((m) => m.text === '现在创建吧')).toBe(false);
      expect(captured?.chatSummary?.summary).toBe('用户正在为 IReader 配置 Project Chat');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('does not record duplicate-event messages into chat memory', async () => {
    const harness = await makeHarness();
    try {
      harness.assistant.decisions.push({ kind: 'reply', text: 'first reply' });
      await harness.transport.handleMessage(message({ eventId: 'dup', chatId: 'control-chat', text: 'only once' }));
      await harness.transport.handleMessage(message({ eventId: 'dup', chatId: 'control-chat', text: 'only once' }));

      const state = await harness.stateStore.load();
      const messages = state.recentMessagesByChatId['control-chat'] ?? [];
      const userOnly = messages.filter((m) => m.role === 'user');
      expect(userOnly).toHaveLength(1);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('does not record unauthorized inbound messages into chat memory', async () => {
    const harness = await makeHarness();
    try {
      await harness.transport.handleMessage(message({ senderOpenId: 'stranger', text: 'leak this' }));
      const state = await harness.stateStore.load();
      expect(state.recentMessagesByChatId['control-chat']).toBeUndefined();
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });
});
