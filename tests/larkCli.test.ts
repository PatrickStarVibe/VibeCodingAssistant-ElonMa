import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { AssistantAdapter, HeavyAgentAdapter } from '../src/adapters.js';
import { createBridgeAgentService } from '../src/larkCli.js';
import type {
  AssistantConfig,
  AssistantRouteResult,
  AssistantTextResult,
  BridgeAgentDecision,
  BridgeAgentInput,
  ControlChatResult,
  IntentResult,
  OrchestratorDecision,
  PlanResult,
  WorkflowDifficulty,
} from '../src/types.js';
import { WorkflowService } from '../src/workflow.js';

class FakeAssistant implements AssistantAdapter {
  inputs: BridgeAgentInput[] = [];
  decisions: BridgeAgentDecision[] = [];

  async decideBridgeAction(input: BridgeAgentInput): Promise<BridgeAgentDecision> {
    this.inputs.push(input);
    return this.decisions.shift() ?? { kind: 'reply', text: 'ok' };
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

describe('lark CLI bootstrap', () => {
  it('creates a bridge agent wired to long-term project memory retrieval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
    try {
      const config = makeConfig(targetDir);
      const store = new ArtifactStore(root, config);
      const assistant = new FakeAssistant();
      const workflow = new WorkflowService(store, config, assistant, new FakeHeavyAgents(), { executeVerification: false });
      const docsDir = join(root, 'project-docs', 'default');
      await mkdir(docsDir, { recursive: true });
      await writeFile(
        join(docsDir, 'memory.md'),
        '# Project Chat Decision\nProject Chat does not bind permanently to task. A task is only the active work unit inside a Project Chat.\n',
        'utf8',
      );

      const agent = createBridgeAgentService(root, workflow, store, assistant, config);
      await agent.handleMessage({
        chatId: 'control-chat',
        senderOpenId: 'user-open-id',
        text: 'Why did we decide Project Chat should not bind permanently to task?',
        chatKind: 'control',
        activeProjectId: 'default',
        canCreateTask: true,
      });

      const input = assistant.inputs[0];
      expect(input?.retrievedMemory?.projectId).toBe('default');
      expect(input?.retrievedMemory?.snippets[0]?.source).toBe('memory.md');
      expect(input?.retrievedMemory?.snippets[0]?.text).toContain('does not bind permanently');
    } finally {
      await cleanup([root, targetDir]);
    }
  });
});
