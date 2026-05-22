import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  normalizeTaskCategory,
  TaskRecordStore,
  validateParentReadmeMarkdown,
  validateSubtaskMarkdown,
} from '../src/taskRecords.js';
import type { ProjectConfig, TaskState } from '../src/types.js';

function makeProject(root: string): ProjectConfig {
  return {
    id: 'ireader',
    name: 'IReader',
    targetDir: root,
    docsDir: 'project-docs/ireader',
  };
}

function makeState(taskId: string): TaskState {
  const now = '2026-05-21T12:00:00.000Z';
  return {
    taskId,
    title: 'Universal task record',
    projectId: 'ireader',
    category: 'Other',
    status: 'created',
    createdAt: now,
    updatedAt: now,
    revisionRound: 0,
    reviewerRunCount: 0,
    executionQueue: [],
    briefConfirmed: false,
    briefRevisionRequests: [],
    userAcceptanceNotes: [],
    artifacts: {},
    requestedChanges: [],
  };
}

async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

describe('TaskRecordStore', () => {
  it('normalizes lightweight categories without blocking unknown values', () => {
    expect(normalizeTaskCategory('Selection / Popup')).toBe('Selection / Popup');
    expect(normalizeTaskCategory('selection / popup')).toBe('Selection / Popup');
    expect(normalizeTaskCategory('unknown category')).toBe('Other');
    expect(normalizeTaskCategory(undefined)).toBe('Other');
  });

  it('initializes parent task folders, placeholders, parent README, and preserves legacy global README content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-record-root-'));
    try {
      const project = makeProject(root);
      const taskRoot = join(root, 'task');
      await mkdir(taskRoot, { recursive: true });
      await writeFile(join(taskRoot, 'README.md'), '# Task Records\n\n## Features\n\n- [Legacy](legacy/README.md)\n', 'utf8');

      const state = makeState('20260521-universal-task-record');
      await new TaskRecordStore().initializeParentTask({
        state,
        project,
        originalRequest: 'Store all task records under one parent task folder.',
      });

      const parentDir = join(taskRoot, state.taskId);
      await expect(readFile(join(parentDir, 'brief.md'), 'utf8')).resolves.toContain('Pending');
      await expect(readFile(join(parentDir, 'plan.md'), 'utf8')).resolves.toContain('Pending');
      await expect(readFile(join(parentDir, 'task-record.md'), 'utf8')).resolves.toContain('Pending');
      await expect(readFile(join(parentDir, 'token-usage.json'), 'utf8')).resolves.toContain('"entries": []');

      const parentReadme = await readFile(join(parentDir, 'README.md'), 'utf8');
      expect(validateParentReadmeMarkdown(parentReadme)).toEqual([]);
      expect(parentReadme).toContain('| Category | Other |');
      expect(parentReadme).toContain('## Token Usage');
      expect(parentReadme).toContain('[token-usage.json](token-usage.json)');
      expect(parentReadme).toContain('Usage is unknown, not zero.');

      const globalReadme = await readFile(join(taskRoot, 'README.md'), 'utf8');
      expect(globalReadme).toContain('Token Usage Ledgers');
      expect(globalReadme).toContain('| Task | Category | Status | Execution Mode | Summary | Updated |');
      expect(globalReadme).toContain('Existing / Legacy Records');
      expect(globalReadme).toContain('[Legacy](legacy/README.md)');
    } finally {
      await cleanup(root);
    }
  });

  it('persists a single approved task as subtasks/01-main.md with required sections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-record-root-'));
    try {
      const project = makeProject(root);
      const state = makeState('20260521-single');
      const store = new TaskRecordStore();
      await store.initializeParentTask({ state, project, originalRequest: 'Single task.' });
      const units = await store.persistApprovedPlan({
        state,
        project,
        planMarkdown: '# Plan\n\nCategory: Manager / Workflow',
        reviewMarkdown: 'Reviewed.',
      });

      expect(units).toHaveLength(1);
      expect(units[0]?.fileName).toBe('01-main.md');
      const subtask = await readFile(join(root, 'task', state.taskId, 'subtasks', '01-main.md'), 'utf8');
      expect(validateSubtaskMarkdown(subtask)).toEqual([]);
    } finally {
      await cleanup(root);
    }
  });

  it('persists decomposed approved tasks as multiple subtasks under the same parent folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-record-root-'));
    try {
      const project = makeProject(root);
      const state = makeState('20260521-decomposed');
      const store = new TaskRecordStore();
      await store.initializeParentTask({ state, project, originalRequest: 'Decomposed task.' });
      const units = await store.persistApprovedPlan({
        state,
        project,
        planMarkdown: '# Plan',
        reviewMarkdown: 'Reviewed.',
        executionUnitDrafts: [
          { name: 'Storage helpers' },
          { name: 'Workflow acceptance' },
        ],
      });

      expect(units.map((unit) => unit.fileName)).toEqual([
        '01-storage-helpers.md',
        '02-workflow-acceptance.md',
      ]);
      await expect(readFile(join(root, 'task', state.taskId, 'subtasks', '01-storage-helpers.md'), 'utf8')).resolves.toContain('# Task 01: Storage helpers');
      await expect(readFile(join(root, 'task', state.taskId, 'subtasks', '02-workflow-acceptance.md'), 'utf8')).resolves.toContain('# Task 02: Workflow acceptance');
    } finally {
      await cleanup(root);
    }
  });
});
