import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProjectKnowledgeService } from '../src/projectKnowledge.js';
import type { ManagerConfig } from '../src/types.js';

function makeConfig(root: string): ManagerConfig {
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
        planReviewer: 'planner',
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

describe('ProjectKnowledgeService', () => {
  it('reads Markdown, ignores non-Markdown, ranks by query, and respects budgets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manager-root-'));
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
});
