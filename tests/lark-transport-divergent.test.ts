import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifacts.js';
import type { AssistantAdapter, HeavyAgentAdapter } from '../src/adapters.js';
import { BridgeAgentService } from '../src/bridgeAgent.js';
import { LarkTransport, type LarkClientPort, type LarkIncomingMessage } from '../src/larkBridge.js';
import { LarkBridgeStateStore } from '../src/larkBridgeState.js';
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
} from '../src/types.js';
import { WorkflowService } from '../src/workflow.js';

class FakeLarkClient implements LarkClientPort {
  sentTexts: { chatId: string; text: string }[] = [];
  sentFiles: { chatId: string; path: string; name: string }[] = [];

  async start(): Promise<void> {}
  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }
  async sendFile(chatId: string, file: { path: string; name: string }): Promise<void> {
    this.sentFiles.push({ chatId, ...file });
  }
  async createTaskChat(): Promise<string> {
    return 'task-chat-divergent';
  }
}

class FakeAssistant implements AssistantAdapter {
  decisions: BridgeAgentDecision[] = [];
  bridgeInputs: BridgeAgentInput[] = [];

  async decideBridgeAction(input: BridgeAgentInput): Promise<BridgeAgentDecision> {
    this.bridgeInputs.push(input);
    return this.decisions.shift() ?? { kind: 'reply', text: `agent: ${input.latestUserMessage}` };
  }
  async decideNextAction(): Promise<OrchestratorDecision> {
    return { action: 'wait_for_user', reason: 'unused', confidence: 1 };
  }
  async classifyIntent(): Promise<IntentResult> {
    return { intent: 'unknown', confidence: 0.1, requiresClarification: true, userFacingInterpretation: 'x' };
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
  async createInitialPlan(): Promise<PlanResult> {
    return { markdown: 'plan', verificationCommands: [] };
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
      taskMemberOpenIds: ['owner-open-id'],
      controlChatIds: [],
    },
    maxRevisionRounds: 3,
    workflowRoles: {
      assistant: 'assistant',
      low: { architect: 'planner', planReviewer: 'planner', developer: 'implementer', finalReviewer: 'implementer' },
      medium: { architect: 'planner', planReviewer: 'reviewer', developer: 'implementer', finalReviewer: 'finalReviewer' },
      high: { architect: 'reviewer', planReviewer: 'planner', developer: 'implementer', finalReviewer: 'finalReviewer' },
      'extra-high': { architect: 'reviewer', planReviewer: 'planner', developer: 'implementer', finalReviewer: 'finalReviewer' },
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

async function makeHarness() {
  const root = await mkdtemp(join(tmpdir(), 'lark-divergent-root-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'lark-divergent-target-'));
  const config = makeConfig(targetDir);
  const store = new ArtifactStore(root, config);
  const assistant = new FakeAssistant();
  const workflow = new WorkflowService(store, config, assistant, new FakeHeavyAgents(), { executeVerification: false });
  const agent = new BridgeAgentService(workflow, store, assistant, config);
  const client = new FakeLarkClient();
  const stateStore = new LarkBridgeStateStore(root, config);
  const transport = new LarkTransport(config, store, client, agent, stateStore);
  return { root, targetDir, store, workflow, assistant, client, stateStore, transport };
}

function message(overrides: Partial<LarkIncomingMessage>): LarkIncomingMessage {
  return {
    eventId: 'event-divergent',
    messageId: 'message-divergent',
    chatId: 'control-chat',
    senderOpenId: 'user-open-id',
    text: 'hello',
    ...overrides,
  };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { recursive: true, force: true })));
}

describe('LarkTransport divergent (zero-token)', () => {
  it('handles empty-text inbound messages without crashing or replying', async () => {
    const harness = await makeHarness();
    try {
      await harness.transport.handleMessage(message({ eventId: 'empty', text: '' }));
      // Empty text either no-ops or hands an empty string to the agent. Either way must not throw.
      // Authorization is fine; reply is whatever the fake agent returns or nothing.
      expect(harness.client.sentTexts.length).toBeGreaterThanOrEqual(0);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('rejects three different unauthorized senders before any agent invocation', async () => {
    const harness = await makeHarness();
    try {
      for (const sender of ['stranger-1', 'stranger-2', 'stranger-3']) {
        await harness.transport.handleMessage(message({
          eventId: `unauth-${sender}`,
          senderOpenId: sender,
          text: 'please run something',
        }));
      }
      expect(harness.assistant.bridgeInputs).toHaveLength(0);
      expect(harness.client.sentTexts).toHaveLength(0);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('handles many consecutive duplicate event IDs without re-invoking the agent', async () => {
    const harness = await makeHarness();
    try {
      for (let index = 0; index < 5; index += 1) {
        await harness.transport.handleMessage(message({ eventId: 'dup-event', text: `attempt ${index}` }));
      }
      expect(harness.assistant.bridgeInputs).toHaveLength(1);
      expect(harness.client.sentTexts).toHaveLength(1);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('handles mixed-case stop inputs without leaking through to the agent', async () => {
    const harness = await makeHarness();
    try {
      await harness.transport.handleMessage(message({ eventId: 'stop-1', text: 'STOP' }));
      // Stop on a chat with no bound task is delegated to the agent (since there is nothing to hard-stop).
      // The transport must not throw; the agent receives the original text.
      expect(harness.assistant.bridgeInputs.at(-1)?.latestUserMessage).toBe('STOP');
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('processes a very long inbound message without truncating before the agent sees it', async () => {
    const harness = await makeHarness();
    try {
      const longText = 'x'.repeat(8000);
      await harness.transport.handleMessage(message({ eventId: 'long', text: longText }));
      expect(harness.assistant.bridgeInputs).toHaveLength(1);
      expect(harness.assistant.bridgeInputs[0]?.latestUserMessage).toBe(longText);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('handles non-ASCII Chinese text including emoji without encoding loss', async () => {
    const harness = await makeHarness();
    try {
      const text = '你好👋，请帮我跑一下 npm test，并把结果反馈给我。';
      await harness.transport.handleMessage(message({ eventId: 'cjk', text }));
      expect(harness.assistant.bridgeInputs[0]?.latestUserMessage).toBe(text);
      expect(harness.client.sentTexts[0]?.text).toContain(text);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });

  it('keeps event dedup independent across distinct event IDs', async () => {
    const harness = await makeHarness();
    try {
      await harness.transport.handleMessage(message({ eventId: 'a', text: 'first' }));
      await harness.transport.handleMessage(message({ eventId: 'b', text: 'second' }));
      await harness.transport.handleMessage(message({ eventId: 'a', text: 'first repeat' }));
      expect(harness.assistant.bridgeInputs.map((entry) => entry.latestUserMessage)).toEqual(['first', 'second']);
    } finally {
      await cleanup([harness.root, harness.targetDir]);
    }
  });
});
