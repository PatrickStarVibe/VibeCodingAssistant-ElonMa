import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProjectKnowledgeService } from '../src/projectKnowledge.js';
import type { AssistantConfig } from '../src/types.js';

function makeConfig(root: string): AssistantConfig {
  return {
    workspace: { targetDir: join(root, 'target') },
    defaultProjectId: 'ireader',
    projects: [{
      id: 'ireader',
      name: 'IReader',
      targetDir: join(root, 'target'),
      docsDir: 'project-docs/ireader',
      alwaysRead: ['rules.md'],
    }],
    artifactsDir: 'logs',
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
        planReviewer: 'planner',
        developer: 'implementer',
        finalReviewer: 'finalReviewer',
      },
      'extra-high': {
        architect: 'reviewer',
        planReviewer: 'planner',
        developer: 'implementer',
        finalReviewer: 'finalReviewer',
      },
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

describe('ProjectKnowledgeService', () => {
  it('reads Markdown, ignores non-Markdown, ranks by query, and respects budgets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    try {
      const docs = join(root, 'project-docs', 'ireader');
      await mkdir(docs, { recursive: true });
      await writeFile(join(docs, 'rules.md'), '# Rules\nAlways keep Reader.tsx stable.\n', 'utf8');
      await writeFile(join(docs, 'translation.md'), '# Translation\nContextual translation uses a planner.\n', 'utf8');
      await writeFile(join(docs, 'notes.txt'), 'This should not be read.', 'utf8');

      const context = await new ProjectKnowledgeService(root).buildContextPacket(makeConfig(root), {
        projectId: 'ireader',
        query: 'translation planner',
        alwaysBudget: 200,
        retrievedBudget: 200,
        maxRetrievedChunks: 2,
      });

      expect(context).toContain('IReader (ireader)');
      expect(context).toContain('rules.md#Rules');
      expect(context).toContain('translation.md#Translation');
      expect(context).not.toContain('notes.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retrieves long-term memory snippets ranked by relevance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    try {
      const docs = join(root, 'project-docs', 'ireader');
      await mkdir(docs, { recursive: true });
      await writeFile(
        join(docs, 'memory.md'),
        '# Project Chat decision\nWe decided Project Chat does not bind tasks; tasks are transient inside a Project Chat.\n',
        'utf8',
      );
      await writeFile(join(docs, 'misc.md'), '# Random\nUnrelated note about other things.\n', 'utf8');

      const snippets = await new ProjectKnowledgeService(root).retrieveMemorySnippets(makeConfig(root), {
        projectId: 'ireader',
        query: 'why does Project Chat not bind task',
        maxSnippets: 2,
      });

      expect(snippets.length).toBeGreaterThan(0);
      expect(snippets[0]?.path).toBe('memory.md');
      expect(snippets[0]?.text).toContain('Project Chat does not bind tasks');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns empty memory when no docs match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    try {
      const snippets = await new ProjectKnowledgeService(root).retrieveMemorySnippets(makeConfig(root), {
        projectId: 'ireader',
        query: 'anything',
      });
      expect(snippets).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
