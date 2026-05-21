import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, ManagerAdapter } from '../src/adapters.js';
import { ManagerConversationService } from '../src/conversation.js';
import { LarkBridge, type LarkClientPort, type LarkIncomingMessage } from '../src/larkBridge.js';
import { LarkBridgeStateStore } from '../src/larkBridgeState.js';
import type { ControlChatResult, ManagerConfig, ManagerRouteResult, ManagerTextResult, PlanResult, TaskProposal, WorkflowDifficulty } from '../src/types.js';
import { WorkflowService } from '../src/workflow.js';

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

class FakeManager implements ManagerAdapter {
  async createTaskBrief(): Promise<ManagerTextResult> {
    return { markdown: 'brief ready', needsUserDecision: false };
  }

  async createRevisionInstructions(): Promise<ManagerTextResult> {
    return { markdown: 'instructions', needsUserDecision: false };
  }

  async explainRevisedPlan(): Promise<ManagerTextResult> {
    return { markdown: 'explanation', needsUserDecision: false };
  }

  async answerQuestion(input: { question: string }): Promise<string> {
    return `answer: ${input.question}`;
  }

  async interpretAmbiguousReply(input: { reply: string }): Promise<string> {
    return `confirm: ${input.reply}`;
  }

  async handleControlChat(input: {
    message: string;
    pendingProposal?: TaskProposal;
    mode: 'message' | 'edit';
  }): Promise<ControlChatResult> {
    if (input.mode === 'edit' && input.pendingProposal) {
      return {
        kind: 'proposal',
        proposal: {
          ...input.pendingProposal,
          title: `${input.pendingProposal.title} edited`,
          task: `${input.pendingProposal.task}\nEdit: ${input.message}`,
          suggestedNextAction: 'Reply create task, edit: <instruction>, or cancel.',
        },
      };
    }
    if (/prompt|先帮我整理一下|先不要创建\s*task|不要执行/i.test(input.message)) {
      return { kind: 'answer', markdown: `prompt draft: ${input.message}` };
    }
    if (/^(帮我|请|实现|检查|修复)/.test(input.message)) {
      return {
        kind: 'proposal',
        proposal: {
          interpretedIntent: `intent: ${input.message}`,
          title: input.message.slice(0, 40),
          task: `Task prompt: ${input.message}`,
          wouldDo: ['Create a workflow task after confirmation.'],
          wouldNotDo: ['Start the workflow before confirmation.'],
          suggestedNextAction: 'Reply create task, edit: <instruction>, or cancel.',
        },
      };
    }
    return { kind: 'answer', markdown: `chat answer: ${input.message}` };
  }

  async routeAfterFinalReview(): Promise<ManagerRouteResult> {
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

function makeConfig(targetDir: string): ManagerConfig {
  return {
    workspace: { targetDir },
    defaultProjectId: 'default',
    projects: [
      {
        id: 'default',
        name: 'Default',
        targetDir,
        docsDir: 'project-docs/default',
        alwaysRead: [],
      },
      {
        id: 'ireader',
        name: 'IReader',
        targetDir,
        docsDir: 'project-docs/ireader',
        alwaysRead: [],
      },
    ],
    artifactsDir: 'logs/ai-workflow',
    lark: {
      platform: 'lark',
      appIdEnv: 'LARK_APP_ID',
      appSecretEnv: 'LARK_APP_SECRET',
      allowedOpenIds: [],
      taskMemberOpenIds: ['owner-open-id'],
      controlChatIds: [],
      watchIntervalSeconds: 1,
      pairingCode: '123456',
    },
    maxRevisionRounds: 3,
    roles: {
      manager: 'manager',
      planner: 'planner',
      reviewer: 'reviewer',
      implementer: 'implementer',
      finalReviewer: 'finalReviewer',
    },
    workflowRoles: {
      low: {
        architect: 'planner',
        planReviewer: 'planner',
        developer: 'implementer',
        finalReviewer: 'implementer',
      },
      medium: {
        architect: 'planner',
        planReviewer: 'reviewer',
        developer: 'implementer',
        finalReviewer: 'finalReviewer',
      },
      high: {
        architect: 'reviewer',
        planReviewer: 'reviewer',
        developer: 'implementer',
        finalReviewer: 'finalReviewer',
      },
    },
    profiles: {
      manager: { kind: 'deepseek' },
      planner: { kind: 'codex' },
      reviewer: { kind: 'claude' },
      implementer: { kind: 'codex' },
      finalReviewer: { kind: 'claude' },
    },
    verification: { allowlist: [] },
  };
}

async function makeBridge(): Promise<{
  root: string;
  targetDir: string;
  bridge: LarkBridge;
  client: FakeLarkClient;
  stateStore: LarkBridgeStateStore;
  conversation: ManagerConversationService;
  store: ArtifactStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'manager-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'manager-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const manager = new FakeManager();
  const workflow = new WorkflowService(store, config, manager, new FakeHeavyAgents(), { executeVerification: false });
  const conversation = new ManagerConversationService(workflow, store, manager, config);
  const client = new FakeLarkClient();
  const stateStore = new LarkBridgeStateStore(root, config);
  return {
    root,
    targetDir,
    bridge: new LarkBridge(config, store, client, conversation, stateStore),
    client,
    stateStore,
    conversation,
    store,
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
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

async function waitFor(assertion: () => void): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

async function pair(bridge: LarkBridge): Promise<void> {
  await bridge.handleMessage(message({ eventId: 'pair', text: '/pair 123456' }));
}

async function bindCreatedTask(
  stateStore: LarkBridgeStateStore,
  conversation: ManagerConversationService,
  chatId = 'task-chat-existing',
): Promise<string> {
  const created = await conversation.createTask({ title: 'Existing task', task: 'Build the chat bridge.' });
  const state = await stateStore.load();
  state.pairedOpenIds = ['user-open-id'];
  state.bindingsByChatId[chatId] = {
    taskId: created.state.taskId,
    title: created.state.title,
    createdAt: new Date().toISOString(),
  };
  await stateStore.save(state);
  return created.state.taskId;
}

describe('LarkBridge', () => {
  it('pairs a Lark user without manually editing config', async () => {
    const { root, targetDir, bridge, client, stateStore } = await makeBridge();
    try {
      await bridge.handleMessage(message({ text: '/pair 123456' }));

      expect(client.sentTexts.at(-1)?.text).toContain('配对成功');
      expect((await stateStore.load()).pairedOpenIds).toContain('user-open-id');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('creates a task chat and binds future messages to the explicit task id', async () => {
    const { root, targetDir, bridge, client, stateStore } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({
        eventId: 'new-task',
        messageId: 'message-2',
        text: '/create Lark bridge\nMake Manager conversational.',
      }));

      expect(client.createdChats).toHaveLength(1);
      expect(client.createdChats[0]?.memberOpenIds).toEqual(['user-open-id', 'owner-open-id']);
      const state = await stateStore.load();
      const binding = state.bindingsByChatId['task-chat-1'];
      expect(binding?.taskId).toMatch(/lark-bridge/);

      await waitFor(() => {
        expect(client.sentFiles.some((file) => file.chatId === 'task-chat-1' && file.name === 'manager-brief.md')).toBe(true);
      });

      await bridge.handleMessage(message({
        eventId: 'status',
        messageId: 'message-3',
        chatId: 'task-chat-1',
        text: 'status',
      }));
      expect(client.sentTexts.at(-1)?.text).toContain(`Task ID: ${binding?.taskId}`);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it.each(['status', '/status', 'summary', '/summary', 'stop', '/stop'])('does not create a task for unbound %s', async (text) => {
    const { root, targetDir, bridge, client } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: `cmd-${text}`, messageId: `msg-${text}`, text }));

      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('no active task');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it.each(['help', '/help'])('does not create a task for unbound %s', async (text) => {
    const { root, targetDir, bridge, client } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: `help-${text}`, messageId: `msg-${text}`, text }));

      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('Manager Lark commands');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('answers normal unbound chat without creating a task', async () => {
    const { root, targetDir, bridge, client } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: 'ambiguous', messageId: 'message-ambiguous', text: 'hello' }));

      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('chat answer: hello');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('directly creates a task only for explicit create commands', async () => {
    const { root, targetDir, bridge, client } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: 'direct-create', messageId: 'message-direct-create', text: 'create task: Build the Lark router' }));
      expect(client.createdChats).toHaveLength(1);
      await waitFor(() => {
        expect(client.sentFiles.some((file) => file.chatId === 'task-chat-1' && file.name === 'manager-brief.md')).toBe(true);
      });
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('uses the active project from a control chat when creating a task', async () => {
    const { root, targetDir, bridge, client, stateStore, store } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: 'project-use', messageId: 'message-project-use', text: '/project use ireader' }));
      expect(client.sentTexts.at(-1)?.text).toContain('Active project set to IReader');

      await bridge.handleMessage(message({ eventId: 'project-task', messageId: 'message-project-task', text: 'create task: Build project memory' }));
      await waitFor(() => {
        expect(client.sentFiles.some((file) => file.chatId === 'task-chat-1' && file.name === 'manager-brief.md')).toBe(true);
      });

      const binding = (await stateStore.load()).bindingsByChatId['task-chat-1'];
      expect(binding).toBeDefined();
      const taskState = await store.loadState(binding?.taskId ?? '');
      expect(taskState.projectId).toBe('ireader');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it.each(['帮我想一下这个 Lark Manager 交互应该怎么改', '实现 Lark proposal flow'])('creates a pending proposal, not a task, for unbound %s', async (text) => {
    const { root, targetDir, bridge, client, stateStore } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: `proposal-${text}`, messageId: `message-${text}`, text }));

      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('task proposal');
      expect((await stateStore.load()).pendingProposalsByChatId['control-chat']?.task).toContain(text);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it.each(['帮我写一个 prompt', '先帮我整理一下', '先不要创建 task', '不要执行'])('returns prompt/chat behavior without creating a task for %s', async (text) => {
    const { root, targetDir, bridge, client, stateStore } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: `prompt-${text}`, messageId: `message-${text}`, text }));

      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('prompt draft:');
      expect((await stateStore.load()).pendingProposalsByChatId['control-chat']).toBeUndefined();
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('confirming a pending proposal creates a task and clears the proposal', async () => {
    const { root, targetDir, bridge, client, stateStore } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: 'proposal-before-confirm', messageId: 'message-before-confirm', text: '帮我想一下 Lark Manager 交互' }));
      expect((await stateStore.load()).pendingProposalsByChatId['control-chat']).toBeDefined();

      await bridge.handleMessage(message({ eventId: 'confirm-proposal', messageId: 'message-confirm-proposal', text: 'confirm' }));
      expect(client.createdChats).toHaveLength(1);
      expect((await stateStore.load()).pendingProposalsByChatId['control-chat']).toBeUndefined();
      await waitFor(() => {
        expect(client.sentFiles.some((file) => file.chatId === 'task-chat-1' && file.name === 'manager-brief.md')).toBe(true);
      });
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('editing a pending proposal updates it without creating a task', async () => {
    const { root, targetDir, bridge, client, stateStore } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: 'proposal-before-edit', messageId: 'message-before-edit', text: '实现 Lark proposal flow' }));
      await bridge.handleMessage(message({ eventId: 'edit-proposal', messageId: 'message-edit-proposal', text: 'edit: keep it small' }));

      expect(client.createdChats).toHaveLength(0);
      const pending = (await stateStore.load()).pendingProposalsByChatId['control-chat'];
      expect(pending?.title).toContain('edited');
      expect(pending?.task).toContain('keep it small');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it.each(['edit: keep it small', 'confirm', 'create task', 'yes create'])('clarifies %s without a pending proposal', async (text) => {
    const { root, targetDir, bridge, client } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: `no-pending-${text}`, messageId: `message-no-pending-${text}`, text }));

      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('There is no pending proposal');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('canceling a pending proposal clears it without creating a task', async () => {
    const { root, targetDir, bridge, client, stateStore } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: 'proposal-before-cancel', messageId: 'message-before-cancel', text: '帮我想一下 Lark Manager 交互' }));
      await bridge.handleMessage(message({ eventId: 'cancel-proposal', messageId: 'message-cancel-proposal', text: 'cancel' }));

      expect(client.createdChats).toHaveLength(0);
      expect((await stateStore.load()).pendingProposalsByChatId['control-chat']).toBeUndefined();
      expect(client.sentTexts.at(-1)?.text).toContain('Canceled');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('surfaces pending proposal state in unbound status and summary', async () => {
    const { root, targetDir, bridge, client } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({ eventId: 'proposal-before-status', messageId: 'message-before-status', text: '实现 Lark proposal flow' }));

      await bridge.handleMessage(message({ eventId: 'status-with-proposal', messageId: 'message-status-with-proposal', text: 'status' }));
      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('Pending task proposal');
      expect(client.sentTexts.at(-1)?.text).toContain('edit: <instruction>');

      await bridge.handleMessage(message({ eventId: 'summary-with-proposal', messageId: 'message-summary-with-proposal', text: 'summary' }));
      expect(client.sentTexts.at(-1)?.text).toContain('Pending task proposal');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('routes task-bound global commands to the current task', async () => {
    const { root, targetDir, bridge, client, stateStore, conversation } = await makeBridge();
    try {
      const taskId = await bindCreatedTask(stateStore, conversation);

      await bridge.handleMessage(message({ eventId: 'bound-status', messageId: 'message-status', chatId: 'task-chat-existing', text: '/status' }));
      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain(`Task ID: ${taskId}`);

      await bridge.handleMessage(message({ eventId: 'bound-summary', messageId: 'message-summary', chatId: 'task-chat-existing', text: '/summary' }));
      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('Revision round');

      await bridge.handleMessage(message({ eventId: 'bound-help', messageId: 'message-help', chatId: 'task-chat-existing', text: 'help' }));
      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('Current task commands');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('routes task-bound stop to the current workflow', async () => {
    const { root, targetDir, bridge, client, stateStore, conversation } = await makeBridge();
    try {
      await bindCreatedTask(stateStore, conversation);
      await bridge.handleMessage(message({ eventId: 'bound-stop', messageId: 'message-bound-stop', chatId: 'task-chat-existing', text: '/stop' }));

      expect(client.createdChats).toHaveLength(0);
      await waitFor(() => {
        expect(client.sentTexts.some((sent) => sent.chatId === 'task-chat-existing' && sent.text.includes('Task stopped'))).toBe(true);
      });
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('routes approve A as a decision when the task is awaiting confirmation', async () => {
    const { root, targetDir, bridge, client, stateStore } = await makeBridge();
    try {
      await pair(bridge);
      await bridge.handleMessage(message({
        eventId: 'new-awaiting-task',
        messageId: 'message-awaiting-task',
        text: 'create task: Awaiting confirmation task',
      }));
      await waitFor(() => {
        expect(client.sentFiles.some((file) => file.chatId === 'task-chat-1' && file.name === 'manager-brief.md')).toBe(true);
      });

      const binding = (await stateStore.load()).bindingsByChatId['task-chat-1'];
      await bridge.handleMessage(message({ eventId: 'approve-a', messageId: 'message-approve-a', chatId: 'task-chat-1', text: 'approve A' }));
      expect(client.createdChats).toHaveLength(1);
      await waitFor(() => {
        expect(client.sentTexts.some((sent) => sent.chatId === 'task-chat-1' && sent.text.includes('Brief approved'))).toBe(true);
      });
      expect((await stateStore.load()).bindingsByChatId['task-chat-1']?.taskId).toBe(binding?.taskId);
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it.each(['A', 'B', 'C'])('asks for clarification for task-bound %s outside decision states', async (text) => {
    const { root, targetDir, bridge, client, stateStore, conversation } = await makeBridge();
    try {
      await bindCreatedTask(stateStore, conversation);
      await bridge.handleMessage(message({ eventId: `letter-${text}`, messageId: `message-letter-${text}`, chatId: 'task-chat-existing', text }));

      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('not sure whether');
      expect(client.sentTexts.at(-1)?.text).toContain('我不确定');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('routes task-bound natural-language questions to task Q&A', async () => {
    const { root, targetDir, bridge, client, stateStore, conversation } = await makeBridge();
    try {
      await bindCreatedTask(stateStore, conversation);
      await bridge.handleMessage(message({
        eventId: 'bound-question',
        messageId: 'message-bound-question',
        chatId: 'task-chat-existing',
        text: '帮我解释这个 plan 是什么意思',
      }));

      expect(client.createdChats).toHaveLength(0);
      expect(client.sentTexts.at(-1)?.text).toContain('answer:');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('allows explicit create tasks from a task-bound chat', async () => {
    const { root, targetDir, bridge, client, stateStore, conversation } = await makeBridge();
    try {
      await bindCreatedTask(stateStore, conversation);
      await bridge.handleMessage(message({
        eventId: 'bound-new',
        messageId: 'message-bound-new',
        chatId: 'task-chat-existing',
        text: 'create task: Separate task',
      }));

      expect(client.createdChats).toHaveLength(1);
      await waitFor(() => {
        expect(client.sentFiles.some((file) => file.chatId === 'task-chat-1' && file.name === 'manager-brief.md')).toBe(true);
      });
    } finally {
      await cleanup([root, targetDir]);
    }
  });
});
