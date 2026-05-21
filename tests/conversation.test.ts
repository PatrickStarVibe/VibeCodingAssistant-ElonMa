import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { HeavyAgentAdapter, ManagerAdapter } from '../src/adapters.js';
import { ManagerConversationService, parseTaskRequest } from '../src/conversation.js';
import type { ControlChatResult, ManagerConfig, ManagerRouteResult, ManagerTextResult, PlanResult, TaskProposal, WorkflowDifficulty } from '../src/types.js';
import { WorkflowService } from '../src/workflow.js';

class FakeManager implements ManagerAdapter {
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
}> {
  const root = await mkdtemp(join(tmpdir(), 'manager-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'manager-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const manager = new FakeManager();
  const workflow = new WorkflowService(store, config, manager, new FakeHeavyAgents(), { executeVerification: false });
  return { root, targetDir, service: new ManagerConversationService(workflow, store, manager, config) };
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
      if (approve.kind === 'reply') expect(approve.messages[0]?.text).toContain('not sure whether');
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
});
