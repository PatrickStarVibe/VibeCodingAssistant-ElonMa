import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { addProjectToRegistry } from '../src/projectRegistry.js';
import type { AssistantConfig } from '../src/types.js';

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

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

describe('project registry', () => {
  it('adds a project from targetDir, persists it, and mutates config.projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    const defaultTarget = await mkdtemp(join(tmpdir(), 'assistant-default-'));
    const targetDir = join(root, 'VibeCodingAssistant-ElonMa Project With Spaces');
    const config = makeConfig(defaultTarget);
    try {
      await mkdir(targetDir);
      const result = await addProjectToRegistry(root, config, { targetDir });

      expect(result.created).toBe(true);
      expect(result.project.id).toBe('vibecodingassistant-elonma-project-with-spaces');
      expect(result.project.name).toBe(targetDir.split(/[\\/]/).pop());
      expect(config.projects?.some((project) => project.id === result.project.id)).toBe(true);

      const persisted = JSON.parse(await readFile(join(root, 'assistant.projects.local.json'), 'utf8')) as {
        projects: Array<{ id: string; targetDir: string }>;
      };
      expect(persisted.projects).toEqual([
        expect.objectContaining({ id: result.project.id, targetDir: result.project.targetDir }),
      ]);
    } finally {
      await cleanup([root, defaultTarget, targetDir]);
    }
  });

  it('returns an existing project for the same targetDir without writing a duplicate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    const defaultTarget = await mkdtemp(join(tmpdir(), 'assistant-default-'));
    const config = makeConfig(defaultTarget);
    try {
      const result = await addProjectToRegistry(root, config, { targetDir: defaultTarget, id: 'other' });

      expect(result.created).toBe(false);
      expect(result.project.id).toBe('default');
      expect(config.projects).toHaveLength(1);
    } finally {
      await cleanup([root, defaultTarget]);
    }
  });

  it('suffixes auto-generated ids and rejects explicit id collisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    const defaultTarget = await mkdtemp(join(tmpdir(), 'assistant-default-'));
    const projectOneParent = await mkdtemp(join(tmpdir(), 'assistant-one-'));
    const projectTwoParent = await mkdtemp(join(tmpdir(), 'assistant-two-'));
    const projectOne = join(projectOneParent, 'Same Name');
    const projectTwo = join(projectTwoParent, 'Same Name');
    const config = makeConfig(defaultTarget);
    try {
      await mkdir(projectOne);
      await mkdir(projectTwo);
      const first = await addProjectToRegistry(root, config, { targetDir: projectOne });
      const second = await addProjectToRegistry(root, config, { targetDir: projectTwo });

      expect(first.project.id).toBe('same-name');
      expect(second.project.id).toBe('same-name-2');
      await expect(addProjectToRegistry(root, config, { targetDir: projectTwo, id: first.project.id }))
        .resolves.toMatchObject({ created: false, project: expect.objectContaining({ id: second.project.id }) });
      const projectThree = await mkdtemp(join(tmpdir(), 'Different Name-'));
      try {
        await expect(addProjectToRegistry(root, config, { targetDir: projectThree, id: first.project.id }))
          .rejects.toThrow('已被');
      } finally {
        await cleanup([projectThree]);
      }
    } finally {
      await cleanup([root, defaultTarget, projectOneParent, projectTwoParent]);
    }
  });

  it('rejects missing target directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    const defaultTarget = await mkdtemp(join(tmpdir(), 'assistant-default-'));
    const config = makeConfig(defaultTarget);
    try {
      await expect(addProjectToRegistry(root, config, { targetDir: join(root, 'missing') }))
        .rejects.toThrow('不存在或不是文件夹');
    } finally {
      await cleanup([root, defaultTarget]);
    }
  });
});
