import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, AssistantAdapter } from '../src/adapters.js';
import { BridgeAgentService } from '../src/bridgeAgent.js';
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
import { WorkflowService } from '../src/workflow.js';

class FakeAssistant implements AssistantAdapter {
  decisions: BridgeAgentDecision[] = [];
  inputs: BridgeAgentInput[] = [];

  async decideBridgeAction(input: BridgeAgentInput): Promise<BridgeAgentDecision> {
    this.inputs.push(input);
    return this.decisions.shift() ?? { kind: 'reply', text: `reply: ${input.latestUserMessage}` };
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

  async interpretAmbiguousReply(): Promise<string> {
    return 'clarify';
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
    projects: [{ id: 'default', name: 'Default', targetDir, docsDir: 'project-docs/default', alwaysRead: [] }],
    artifactsDir: 'logs/ai-workflow',
    lark: {
      platform: 'lark',
      appIdEnv: 'LARK_APP_ID',
      appSecretEnv: 'LARK_APP_SECRET',
      allowedOpenIds: ['user-open-id'],
      taskMemberOpenIds: [],
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
  agent: BridgeAgentService;
  config: AssistantConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  const workflow = new WorkflowService(store, config, assistant, new FakeHeavyAgents(), { executeVerification: false });
  return {
    root,
    targetDir,
    store,
    workflow,
    assistant,
    agent: new BridgeAgentService(workflow, store, assistant, config),
    config,
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

async function createTaskAtDifficultyGate(harness: Awaited<ReturnType<typeof makeHarness>>): Promise<string> {
  const created = await harness.workflow.createTask({ title: 'Agent task', task: 'Build it.' });
  await harness.workflow.planTask(created.state.taskId);
  return created.state.taskId;
}

async function createTaskAwaitingAcceptance(harness: Awaited<ReturnType<typeof makeHarness>>): Promise<string> {
  const taskId = await createTaskAtDifficultyGate(harness);
  await harness.workflow.reply(taskId, 'low');
  await harness.workflow.reply(taskId, 'approve A');
  expect((await harness.store.loadState(taskId)).status).toBe('awaiting_user_acceptance');
  return taskId;
}

function activeTaskChat(taskId: string, chatId = 'task-chat') {
  return {
    chatKind: 'project' as const,
    projectChat: { projectId: 'default', hasActiveTask: true },
    activeTask: { chatId, taskId, title: 'Agent task', startedAt: new Date().toISOString() },
    canCreateTask: false,
  };
}

describe('BridgeAgentService', () => {
  it('uses choose_difficulty for low natural language choices', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'choose_difficulty', arguments: { difficulty: 'low', instruction: '按原 prompt 做' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'low，就按我原 prompt 做',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        const result = await turn.run();
        expect(result.state.difficulty).toBe('low');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('answers questions without mutating state', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({ kind: 'reply', text: '难度决定 Planner/Reviewer 的组合。' });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '为什么要选难度',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      expect((await harness.store.loadState(taskId)).status).toBe('awaiting_difficulty_selection');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('stops tasks via stop_task tool calls', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'stop_task', arguments: {} } });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '我想取消这个任务',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.clearActiveTask).toEqual({ taskId });
      expect((await harness.store.loadState(taskId)).status).toBe('stopped');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('accepts completed work via accept_task tool calls', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAwaitingAcceptance(harness);
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'accept_task', arguments: {} } });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'Accept',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.clearActiveTask).toEqual({ taskId });
      const state = await harness.store.loadState(taskId);
      expect(state.status).toBe('completed');
      expect(state.artifacts['final-report']).toBeTruthy();
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('renders awaiting acceptance status without saying the plan still needs approval', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAwaitingAcceptance(harness);
      harness.assistant.decisions.push({ kind: 'tool_call', toolCall: { name: 'show_status', arguments: {} } });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: '现在在哪个阶段',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.messages[0]?.text).toContain('等待你验收');
        expect(turn.messages[0]?.text).toContain('task recording');
        expect(turn.messages[0]?.text).not.toContain('等待批准实现');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('returns a safe explanation for invalid tool arguments', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAtDifficultyGate(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'choose_difficulty', arguments: { difficulty: 'tiny' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'tiny difficulty',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.messages[0]?.text).toContain('没有执行');
      expect((await harness.store.loadState(taskId)).status).toBe('awaiting_difficulty_selection');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('adds a project via add_project and makes it active for the current chat', async () => {
    const harness = await makeHarness();
    const projectDir = join(harness.root, 'Assistant Manager');
    try {
      await mkdir(projectDir);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'add_project',
          arguments: { targetDir: projectDir, name: 'Manager' },
        },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: `添加项目，路径是 ${projectDir}`,
        chatKind: 'control',
        canCreateTask: true,
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind !== 'reply') return;
      expect(turn.activeProjectId).toBe('assistant-manager');
      expect(turn.messages[0]?.text).toContain('项目已添加');
      expect(harness.config.projects?.some((project) => project.id === 'assistant-manager')).toBe(true);
      const registry = JSON.parse(await readFile(join(harness.root, 'assistant.projects.local.json'), 'utf8')) as {
        projects: Array<{ id: string; targetDir: string }>;
      };
      expect(registry.projects[0]).toMatchObject({ id: 'assistant-manager', targetDir: projectDir });
    } finally {
      await cleanup([harness.root, harness.targetDir, projectDir]);
    }
  });

  it('creates the next task in the project added during the same process', async () => {
    const harness = await makeHarness();
    const projectDir = join(harness.root, 'Assistant Manager');
    try {
      await mkdir(projectDir);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'add_project',
          arguments: { targetDir: projectDir, name: 'Manager' },
        },
      });
      const addTurn = await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: `添加项目 ${projectDir}`,
        chatKind: 'control',
        canCreateTask: true,
      });
      expect(addTurn.kind).toBe('reply');
      if (addTurn.kind !== 'reply') return;

      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: {
          name: 'create_task',
          arguments: { title: 'Manager task', prompt: 'Create a small Manager task.' },
        },
      });
      const createTurn = await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: '创建一个 Manager task',
        chatKind: 'control',
        activeProjectId: addTurn.activeProjectId ?? undefined,
        canCreateTask: true,
      });

      expect(createTurn.kind).toBe('task_created');
      if (createTurn.kind !== 'task_created') return;
      expect(createTurn.projectId).toBe('assistant-manager');
      expect(createTurn.projectName).toBe('Manager');
      const state = await harness.store.loadState(createTurn.taskId);
      expect(state.projectId).toBe('assistant-manager');
      await expect(readFile(join(projectDir, 'task', createTurn.taskId, 'README.md'), 'utf8'))
        .resolves.toContain('Manager task');
    } finally {
      await cleanup([harness.root, harness.targetDir, projectDir]);
    }
  });

  it('lists projects with active and default markers', async () => {
    const harness = await makeHarness();
    try {
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'list_projects', arguments: {} },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: '项目列表',
        chatKind: 'control',
        activeProjectId: 'default',
        canCreateTask: true,
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') {
        expect(turn.messages[0]?.text).toContain('default: Default');
        expect(turn.messages[0]?.text).toContain('默认');
        expect(turn.messages[0]?.text).toContain('当前');
      }
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('catches async tool failures and explains instead of throwing out to transport', async () => {
    const harness = await makeHarness();
    try {
      const taskId = await createTaskAwaitingAcceptance(harness);
      harness.assistant.decisions.push({
        kind: 'tool_call',
        toolCall: { name: 'show_artifact', arguments: { artifact: 'final-report' } },
      });

      const turn = await harness.agent.handleMessage({
        chatId: 'task-chat',
        senderOpenId: 'user-open-id',
        text: 'show final report',
        ...activeTaskChat(taskId),
      });

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.messages[0]?.text).toContain('没有执行');
      expect((await harness.store.loadState(taskId)).status).toBe('awaiting_user_acceptance');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });
});
