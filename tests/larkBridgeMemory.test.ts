import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendRecentMessage,
  getChatSummary,
  getRecentMessages,
  LarkBridgeStateStore,
  RECENT_MESSAGES_LIMIT,
  setChatSummary,
  type LarkBridgeState,
} from '../src/larkBridgeState.js';
import type { AssistantConfig } from '../src/types.js';

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
      allowedOpenIds: [],
      taskMemberOpenIds: [],
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

function emptyState(): LarkBridgeState {
  return {
    projectChatsByChatId: {},
    activeTaskByChatId: {},
    activeProjectIdByChatId: {},
    runningJobsByTaskId: {},
    recentMessagesByChatId: {},
    chatSummariesByChatId: {},
    processedEventIds: [],
  };
}

describe('chat memory state', () => {
  it('appends and trims recent messages to the limit', () => {
    const state = emptyState();
    for (let i = 0; i < RECENT_MESSAGES_LIMIT + 5; i += 1) {
      appendRecentMessage(state, 'chat-1', {
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `msg ${i}`,
        at: new Date(2025, 0, 1, 0, 0, i).toISOString(),
      });
    }
    const messages = getRecentMessages(state, 'chat-1');
    expect(messages).toHaveLength(RECENT_MESSAGES_LIMIT);
    expect(messages[0]?.text).toBe('msg 5');
    expect(messages[messages.length - 1]?.text).toBe(`msg ${RECENT_MESSAGES_LIMIT + 4}`);
  });

  it('keeps memory per chat independent', () => {
    const state = emptyState();
    appendRecentMessage(state, 'a', { role: 'user', text: 'hello a', at: 't1' });
    appendRecentMessage(state, 'b', { role: 'user', text: 'hello b', at: 't1' });
    expect(getRecentMessages(state, 'a')).toHaveLength(1);
    expect(getRecentMessages(state, 'b')).toHaveLength(1);
    expect(getRecentMessages(state, 'a')[0]?.text).toBe('hello a');
  });

  it('stores and clears chat summary', () => {
    const state = emptyState();
    setChatSummary(state, 'chat-1', { summary: 'context so far', messageCountCovered: 12, updatedAt: '2025-01-01T00:00:00Z' });
    expect(getChatSummary(state, 'chat-1')).toEqual({
      summary: 'context so far',
      messageCountCovered: 12,
      updatedAt: '2025-01-01T00:00:00Z',
    });
    setChatSummary(state, 'chat-1', { summary: '   ', messageCountCovered: 0 });
    expect(getChatSummary(state, 'chat-1')).toBeUndefined();
  });

  it('loads legacy state without recentMessages/chatSummaries without errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
    try {
      const config = makeConfig(targetDir);
      const store = new LarkBridgeStateStore(root, config);
      await mkdir(join(root, 'logs', 'ai-workflow'), { recursive: true });
      await writeFile(
        store.statePath(),
        JSON.stringify({
          projectChatsByChatId: {
            'chat-1': { chatId: 'chat-1', projectId: 'default', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
          },
          activeTaskByChatId: {},
          activeProjectIdByChatId: {},
          runningJobsByTaskId: {},
          processedEventIds: [],
        }),
        'utf8',
      );

      const loaded = await store.load();
      expect(loaded.recentMessagesByChatId).toEqual({});
      expect(loaded.chatSummariesByChatId).toEqual({});

      const persisted = JSON.parse(await readFile(store.statePath(), 'utf8')) as Record<string, unknown>;
      expect(persisted.recentMessagesByChatId).toEqual({});
      expect(persisted.chatSummariesByChatId).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it('round-trips recent messages and summary through the state store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'assistant-target-'));
    try {
      const config = makeConfig(targetDir);
      const store = new LarkBridgeStateStore(root, config);
      const state = await store.load();
      appendRecentMessage(state, 'chat-1', { role: 'user', text: 'hi', at: '2025-01-01T00:00:00Z', messageId: 'm1', eventId: 'e1' });
      appendRecentMessage(state, 'chat-1', { role: 'assistant', text: 'hello back', at: '2025-01-01T00:00:01Z' });
      setChatSummary(state, 'chat-1', { summary: 'they greeted each other', messageCountCovered: 2 });
      await store.save(state);

      const reloaded = await store.load();
      const messages = getRecentMessages(reloaded, 'chat-1');
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe('user');
      expect(messages[0]?.messageId).toBe('m1');
      expect(messages[0]?.eventId).toBe('e1');
      expect(messages[1]?.role).toBe('assistant');
      expect(getChatSummary(reloaded, 'chat-1')?.summary).toBe('they greeted each other');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
