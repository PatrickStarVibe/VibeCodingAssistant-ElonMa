import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, ManagerAdapter } from '../src/adapters.js';
import { ManagerConversationService, parseTaskRequest } from '../src/conversation.js';
import type { ControlChatResult, IntentResult, ManagerConfig, ManagerRouteResult, ManagerTextResult, PlanResult, TaskChatRouteResult, TaskProposal, WorkflowDifficulty } from '../src/types.js';
import { WorkflowService } from '../src/workflow.js';

class FakeManager implements ManagerAdapter {
  controlProjectContexts: string[] = [];
  intents: IntentResult[] = [];
  taskRoutes: TaskChatRouteResult[] = [];

  async createTaskBrief(): Promise<ManagerTextResult> {
    return { markdown: 'brief', needsUserDecision: false };
  }

  async createRevisionInstructions(): Promise<ManagerTextResult> {
    return { markdown: 'revise instructions', needsUserDecision: false };
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

  async classifyIntent(input: { userMessage: string }): Promise<IntentResult> {
    const next = this.intents.shift();
    if (next) return next;
    const message = input.userMessage.toLocaleLowerCase();
    if (message === 'status' || message === '/status') return intent('status', '查看状态');
    if (message === 'summary' || message === '/summary') return intent('summary', '查看总结');
    if (message.includes('?') || input.userMessage.includes('？')) return intent('ask', '询问当前任务');
    if (message.includes('high')) return intent('difficulty', '选择高难度', { difficulty: 'high' });
    if (message.includes('medium') || input.userMessage.includes('默认')) return intent('difficulty', '选择中等难度', { difficulty: 'medium' });
    if (message === 'a' || input.userMessage.includes('可以') || input.userMessage.includes('继续')) return intent('approve', 'Received. I will approve the brief.');
    return intent('unknown', '我还不确定你的意思', { confidence: 0.4, requiresClarification: true });
  }

  async composeReply(input: { rawMessage: string }): Promise<{ text: string }> {
    return { text: input.rawMessage };
  }

  async routeTaskChat(input: { message: string; state: { status: string } }): Promise<TaskChatRouteResult> {
    const route = this.taskRoutes.shift();
    if (route) return route;
    return {
      action: 'reply_only',
      confidence: 0.9,
      reason: `test fallback for ${input.message}`,
      replyMarkdown: `我在。当前状态：${input.state.status}`,
    };
  }

  async handleControlChat(input: {
    message: string;
    pendingProposal?: TaskProposal;
    mode: 'message' | 'edit';
    projectContext: string;
  }): Promise<ControlChatResult> {
    this.controlProjectContexts.push(input.projectContext);
    if (input.mode === 'edit' && input.pendingProposal) {
      return {
        kind: 'proposal',
        proposal: {
          ...input.pendingProposal,
          task: `${input.pendingProposal.task}\nEdit: ${input.message}`,
        },
      };
    }
    if (/prompt|不要执行|先不要创建\s*task/.test(input.message)) {
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

function intent(
  name: IntentResult['intent'],
  userFacingInterpretation: string,
  extras: Partial<IntentResult> = {},
): IntentResult {
  return {
    intent: name,
    confidence: 0.95,
    requiresClarification: false,
    userFacingInterpretation,
    ...extras,
  };
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
    artifactsDir: 'logs/ai-workflow',
    lark: {
      platform: 'lark',
      appIdEnv: 'LARK_APP_ID',
      appSecretEnv: 'LARK_APP_SECRET',
      allowedOpenIds: [],
      taskMemberOpenIds: [],
      controlChatIds: [],
      watchIntervalSeconds: 10,
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

async function makeConversation(): Promise<{
  root: string;
  targetDir: string;
  service: ManagerConversationService;
  manager: FakeManager;
  store: ArtifactStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'manager-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'manager-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const manager = new FakeManager();
  const workflow = new WorkflowService(store, config, manager, new FakeHeavyAgents(), { executeVerification: false });
  return { root, targetDir, service: new ManagerConversationService(workflow, store, manager, config), manager, store };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

describe('ManagerConversationService', () => {
  it('parses direct task creation requests only', () => {
    expect(parseTaskRequest('/create Feedback UI\nFix hover behavior')).toEqual({
      title: 'Feedback UI',
      task: 'Fix hover behavior',
    });
    expect(parseTaskRequest('create task: Feedback UI')).toEqual({
      title: 'Feedback UI',
      task: 'Feedback UI',
    });
    expect(parseTaskRequest('new task: Feedback UI')).toEqual({
      title: 'Feedback UI',
      task: 'Feedback UI',
    });
    expect(parseTaskRequest('/new Feedback UI')).toBeUndefined();
    expect(parseTaskRequest('new: Feedback UI')).toBeUndefined();
    expect(parseTaskRequest('task: Feedback UI')).toBeUndefined();
    expect(parseTaskRequest('修复登录 bug')).toBeUndefined();
    expect(parseTaskRequest('status')).toBeUndefined();
    expect(parseTaskRequest('summary')).toBeUndefined();
    expect(parseTaskRequest('hello')).toBeUndefined();
  });

  it('routes readonly, question, artifact, and mutating task messages', async () => {
    const { root, targetDir, service } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Chat task', task: 'Build the chat bridge.' });

      const status = await service.routeTaskMessage(created.state.taskId, 'status');
      expect(status.kind).toBe('reply');
      if (status.kind === 'reply') expect(status.messages[0]?.text).toContain('Status: created');

      const question = await service.routeTaskMessage(created.state.taskId, '这个方案风险最大在哪里？');
      expect(question.kind).toBe('reply');
      if (question.kind === 'reply') expect(question.messages[0]?.text).toContain('answer:');

      const artifact = await service.routeTaskMessage(created.state.taskId, '/show original-task');
      expect(artifact.kind).toBe('reply');
      if (artifact.kind === 'reply') expect(artifact.messages[0]?.files?.[0]?.name).toBe('original-task.md');

      const approve = await service.routeTaskMessage(created.state.taskId, 'A');
      expect(approve.kind).toBe('reply');
      if (approve.kind === 'reply') expect(approve.messages[0]?.text).toContain('不能执行');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('routes single-letter decisions only while awaiting an A/B/C decision', async () => {
    const { root, targetDir, service } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Decision task', task: 'Build the chat bridge.' });
      await service.startBrief(created.state.taskId).run();

      const approve = await service.routeTaskMessage(created.state.taskId, 'A');
      expect(approve.kind).toBe('background');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('uses the task chat route to approve natural-language brief confirmation', async () => {
    const { root, targetDir, service, manager } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Natural approve task', task: 'Build the chat bridge.' });
      await service.startBrief(created.state.taskId).run();
      manager.intents.push({
        intent: 'approve',
        confidence: 0.95,
        requiresClarification: false,
        userFacingInterpretation: 'Received. I will approve the brief.',
      });

      const turn = await service.routeTaskMessage(created.state.taskId, '\u53ef\u4ee5\uff0c\u7ee7\u7eed');

      expect(turn.kind).toBe('background');
      if (turn.kind === 'background') {
        expect(turn.startedMessage.text).toContain('Received');
        const result = await turn.run();
        expect(result.state.status).toBe('awaiting_difficulty_selection');
      }
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('uses the task chat route to choose the default difficulty from natural language', async () => {
    const { root, targetDir, service, manager } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Natural difficulty task', task: 'Build the chat bridge.' });
      await service.startBrief(created.state.taskId).run();
      manager.intents.push(intent('approve', 'approve brief'));
      const approve = await service.routeTaskMessage(created.state.taskId, '\u53ef\u4ee5\uff0c\u7ee7\u7eed');
      if (approve.kind !== 'background') throw new Error('expected approve to start background work');
      await approve.run();

      manager.intents.push({
        intent: 'difficulty',
        confidence: 0.93,
        requiresClarification: false,
        userFacingInterpretation: 'The user asked for the default workflow difficulty.',
        difficulty: 'medium',
      });
      const choose = await service.routeTaskMessage(created.state.taskId, '\u8d70\u9ed8\u8ba4\u96be\u5ea6');

      expect(choose.kind).toBe('background');
      if (choose.kind === 'background') {
        const result = await choose.run();
        expect(result.state.difficulty).toBe('medium');
        expect(result.state.status).toBe('ready_for_decision');
      }
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('asks for confirmation when the task chat route is low confidence', async () => {
    const { root, targetDir, service, manager, store } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Low confidence task', task: 'Build the chat bridge.' });
      await service.startBrief(created.state.taskId).run();
      manager.intents.push(intent('approve', 'approve brief'));
      const approve = await service.routeTaskMessage(created.state.taskId, '\u53ef\u4ee5\uff0c\u7ee7\u7eed');
      if (approve.kind !== 'background') throw new Error('expected approve to start background work');
      await approve.run();

      manager.intents.push({
        intent: 'difficulty',
        confidence: 0.4,
        requiresClarification: true,
        userFacingInterpretation: 'Do you mean high difficulty?',
        difficulty: 'high',
      });
      const turn = await service.routeTaskMessage(created.state.taskId, 'maybe high');

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.messages[0]?.text).toContain('Do you mean high');
      expect((await store.loadState(created.state.taskId)).status).toBe('awaiting_difficulty_selection');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('blocks routed workflow actions that are not allowed in the current state', async () => {
    const { root, targetDir, service, manager, store } = await makeConversation();
    try {
      const created = await service.createTask({ title: 'Blocked route task', task: 'Build the chat bridge.' });
      manager.intents.push({
        intent: 'approve',
        confidence: 0.95,
        requiresClarification: false,
        userFacingInterpretation: 'The user wants to start implementation.',
      });

      const turn = await service.routeTaskMessage(created.state.taskId, 'start implementation');

      expect(turn.kind).toBe('reply');
      if (turn.kind === 'reply') expect(turn.messages[0]?.text).toContain('不能执行');
      expect((await store.loadState(created.state.taskId)).status).toBe('created');
    } finally {
      await cleanup([root, targetDir]);
    }
  });

  it('injects project Markdown context into unbound control chat', async () => {
    const { root, targetDir, service, manager } = await makeConversation();
    try {
      const docsDir = join(root, 'project-docs', 'default');
      await mkdir(docsDir, { recursive: true });
      await writeFile(join(docsDir, 'ireader.md'), '# iReader\nProject memory is readable from General chat.\n', 'utf8');

      const turn = await service.routeControlMessage('你去读一下 iReader 的内容');

      expect(turn.kind).toBe('reply');
      expect(manager.controlProjectContexts[0]).toContain('ireader.md#iReader');
      expect(manager.controlProjectContexts[0]).toContain('Project memory is readable');
    } finally {
      await cleanup([root, targetDir]);
    }
  });
});
