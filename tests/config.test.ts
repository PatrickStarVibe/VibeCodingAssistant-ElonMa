import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultConfig, loadConfig, normalizeConfig } from '../src/config.js';

describe('workflow role config', () => {
  it('defaults to provider-neutral workflow roles', () => {
    const config = defaultConfig();

    expect(config.workflowRoles.assistant).toBe('assistant-api');
    expect(config.workflowRoles.low).toEqual({
      architect: 'architect-agent',
      planReviewer: 'plan-reviewer-agent',
      developer: 'developer-agent',
      finalReviewer: 'final-reviewer-agent',
    });
    expect(config.workflowRoles.medium).toEqual({
      architect: 'architect-agent',
      planReviewer: 'plan-reviewer-agent',
      developer: 'developer-agent',
      finalReviewer: 'final-reviewer-agent',
    });
    expect(config.workflowRoles.high).toEqual({
      architect: 'architect-agent',
      planReviewer: 'plan-reviewer-agent',
      developer: 'developer-agent',
      finalReviewer: 'final-reviewer-agent',
    });
    expect(config.workflowRoles['extra-high']).toEqual(config.workflowRoles.high);
    expect(config.profiles[config.workflowRoles.assistant]).toMatchObject({
      kind: 'openai-compatible',
      apiKeyEnv: 'ASSISTANT_API_KEY',
    });
    expect(config.profiles[config.workflowRoles.assistant]?.provider).toBeUndefined();
    expect(config.profiles[config.workflowRoles.assistant]?.model).toBeUndefined();
    expect(config.profiles[config.workflowRoles.assistant]?.baseUrl).toBeUndefined();
    expect(config.profiles[config.workflowRoles.high.architect]).toEqual({ kind: 'command' });
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
          provider: 'acme-compatible',
          model: 'acme-chat',
          baseUrl: 'https://api.acme.test/v1',
          apiKeyEnv: 'ACME_API_KEY',
        },
        'custom-medium-developer': {
          kind: 'command',
          provider: 'custom-cli',
          command: 'custom-agent',
        },
      },
    });

    expect(config.workflowRoles.assistant).toBe('custom-assistant');
    expect(config.workflowRoles.medium.developer).toBe('custom-medium-developer');
    expect(config.workflowRoles.medium.architect).toBe('architect-agent');
    expect(config.profiles['custom-assistant']).toMatchObject({
      kind: 'openai-compatible',
      provider: 'acme-compatible',
      model: 'acme-chat',
      baseUrl: 'https://api.acme.test/v1',
      apiKeyEnv: 'ACME_API_KEY',
    });
    expect(config.profiles['custom-medium-developer']?.command).toBe('custom-agent');
  });

  it('fills missing extra-high workflow roles from high for old configs', () => {
    const config = normalizeConfig({
      workflowRoles: {
        high: {
          architect: 'custom-high-architect',
          planReviewer: 'custom-high-reviewer',
          developer: 'custom-high-developer',
          finalReviewer: 'custom-high-final-reviewer',
        },
      },
    });

    expect(config.workflowRoles['extra-high']).toEqual(config.workflowRoles.high);
  });

  it('retains legacy DeepSeek profiles as explicit compatibility config', () => {
    const config = normalizeConfig({
      workflowRoles: {
        assistant: 'legacy-assistant',
      },
      profiles: {
        'legacy-assistant': {
          kind: 'deepseek',
        },
      },
    });

    expect(config.profiles['legacy-assistant']).toEqual({
      kind: 'openai-compatible',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    });
  });

  it('loads the example config without requiring a fixed provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    try {
      const example = await readFile(new URL('../assistant.config.example.json', import.meta.url), 'utf8');
      const rawExample = JSON.parse(example) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      await writeFile(join(root, 'assistant.config.example.json'), example, 'utf8');

      const config = await loadConfig(root);

      expect(rawExample.profiles['assistant-api']?.provider).toBeUndefined();
      expect(rawExample.profiles['assistant-api']?.model).toBe('');
      expect(rawExample.profiles['assistant-api']?.baseUrl).toBe('');
      expect(config.workflowRoles.assistant).toBe('assistant-api');
      expect(config.profiles['assistant-api']).toEqual({
        kind: 'openai-compatible',
        apiKeyEnv: 'ASSISTANT_API_KEY',
      });
      expect(config.profiles['architect-agent']).toEqual({ kind: 'command' });
      expect(JSON.stringify(config.profiles)).not.toContain('deepseek-v4-flash');
      expect(JSON.stringify(config.profiles)).not.toContain('claude-opus');
      expect(JSON.stringify(config.profiles)).not.toContain('gpt-5.5');
      expect(JSON.stringify(config.profiles)).not.toContain('your-');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads .env.local without overriding existing process env values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-root-'));
    const previousExisting = process.env.EXISTING_PROVIDER_KEY;
    const previousLocal = process.env.LOCAL_ONLY_PROVIDER_KEY;
    try {
      process.env.EXISTING_PROVIDER_KEY = 'from-process';
      delete process.env.LOCAL_ONLY_PROVIDER_KEY;
      await writeFile(join(root, 'assistant.config.example.json'), JSON.stringify({
        workspace: { targetDir: 'target' },
      }), 'utf8');
      await writeFile(join(root, '.env.local'), [
        'EXISTING_PROVIDER_KEY=from-local',
        'LOCAL_ONLY_PROVIDER_KEY="from local"',
      ].join('\n'), 'utf8');

      await loadConfig(root);

      expect(process.env.EXISTING_PROVIDER_KEY).toBe('from-process');
      expect(process.env.LOCAL_ONLY_PROVIDER_KEY).toBe('from local');
    } finally {
      if (previousExisting === undefined) {
        delete process.env.EXISTING_PROVIDER_KEY;
      } else {
        process.env.EXISTING_PROVIDER_KEY = previousExisting;
      }
      if (previousLocal === undefined) {
        delete process.env.LOCAL_ONLY_PROVIDER_KEY;
      } else {
        process.env.LOCAL_ONLY_PROVIDER_KEY = previousLocal;
      }
      await rm(root, { recursive: true, force: true });
    }
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
