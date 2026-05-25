import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultConfig, loadConfig, normalizeConfig } from '../src/config.js';

describe('workflow role config', () => {
  it('defaults fixed workflow roles by difficulty', () => {
    const config = defaultConfig();

    expect(config.workflowRoles.assistant).toBe('assistant-elon-ma');
    expect(config.workflowRoles.low).toEqual({
      architect: 'codex-architect',
      planReviewer: 'codex-plan-reviewer',
      developer: 'codex-developer',
      finalReviewer: 'codex-final-reviewer',
    });
    expect(config.workflowRoles.medium).toEqual({
      architect: 'codex-architect',
      planReviewer: 'claude-plan-reviewer',
      developer: 'codex-developer',
      finalReviewer: 'claude-final-reviewer',
    });
    expect(config.workflowRoles.high).toEqual({
      architect: 'claude-architect',
      planReviewer: 'codex-plan-reviewer',
      developer: 'codex-developer',
      finalReviewer: 'claude-final-reviewer',
    });
    expect(config.profiles[config.workflowRoles.high.architect]?.kind).toBe('claude');
    expect(config.profiles[config.workflowRoles.high.planReviewer]?.kind).toBe('codex');
    expect(config.profiles['codex-architect']).toMatchObject({
      model: 'gpt-5.5',
      effort: 'xhigh',
    });
    expect(config.profiles['claude-plan-reviewer']).toMatchObject({
      model: 'claude-opus-4-7',
      effort: 'high',
    });
  });

  it('lets each difficulty role point at a different profile', () => {
    const config = normalizeConfig({
      workflowRoles: {
        assistant: 'custom-assistant',
        medium: {
          developer: 'custom-medium-developer',
        },
      },
      profiles: {
        'custom-assistant': {
          kind: 'deepseek',
        },
        'custom-medium-developer': {
          kind: 'codex',
          command: 'custom-codex',
        },
      },
    });

    expect(config.workflowRoles.assistant).toBe('custom-assistant');
    expect(config.workflowRoles.medium.developer).toBe('custom-medium-developer');
    expect(config.workflowRoles.medium.architect).toBe('codex-architect');
    expect(config.profiles['custom-medium-developer']?.command).toBe('custom-codex');
  });

  it('loads dynamic projects from assistant.projects.local.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    const staticTarget = await mkdtemp(join(tmpdir(), 'assistant-static-'));
    const dynamicTarget = await mkdtemp(join(tmpdir(), 'assistant-dynamic-'));
    try {
      await writeFile(join(root, 'assistant.config.example.json'), JSON.stringify({
        workspace: { targetDir: staticTarget },
        defaultProjectId: 'static',
        projects: [{
          id: 'static',
          name: 'Static',
          targetDir: staticTarget,
          docsDir: 'project-docs/static',
          alwaysRead: [],
        }],
      }), 'utf8');
      await writeFile(join(root, 'assistant.projects.local.json'), JSON.stringify({
        projects: [{
          id: 'dynamic',
          name: 'Dynamic',
          targetDir: dynamicTarget,
          docsDir: 'project-docs/dynamic',
          alwaysRead: [],
        }],
      }), 'utf8');

      const config = await loadConfig(root);

      expect(config.projects?.map((project) => project.id)).toEqual(['static', 'dynamic']);
      expect(config.defaultProjectId).toBe('static');
      expect(config.projects?.find((project) => project.id === 'dynamic')?.targetDir).toBe(dynamicTarget);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staticTarget, { recursive: true, force: true });
      await rm(dynamicTarget, { recursive: true, force: true });
    }
  });
});
