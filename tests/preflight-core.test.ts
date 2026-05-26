/*
 * Tests for the Manager distribution preflight core helpers.
 * Covers config-derived env contracts, runtime-mirrored parsing, profile validation, and command probing.
 * Author: Manager distribution tooling
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const preflightCorePath = path.join(repoRoot, 'scripts', 'lib', 'preflightCore.mjs');

type PreflightCore = {
  parseEnvFile: (filePath: string) => Promise<{ vars: Map<string, string>; exists: boolean }>;
  loadConfig: (options: {
    explicitPath?: string;
    cwd?: string;
    allowExampleFallback?: boolean;
  }) => Promise<{
    rawProfileMeta: Record<string, {
      rawNpmScript?: string | null;
      rawHasCommand?: boolean;
      rawKind?: string | null;
    }>;
    normalized: Record<string, unknown>;
    source: string | null;
    sourceKind: string;
    warnings: Array<unknown>;
  }>;
  effectiveEnvValue: (
    name: string,
    parsedEnvFile: { vars: Map<string, string>; exists: boolean },
  ) => { value: string | undefined; source: string | null };
  collectRequiredEnvNames: (normalized: Record<string, unknown>) => {
    apiKeyEnvs: string[];
    larkEnvs: string[];
    byProfile: Record<string, string[]>;
  };
  isPlaceholderValue: (value: unknown) => boolean;
  validateProfiles: (
    normalized: Record<string, unknown>,
    rawProfileMeta: Record<string, unknown>,
  ) => { errors: Array<unknown>; warnings: Array<unknown> };
  validateWorkspacePaths: (normalized: Record<string, unknown>) => { errors: Array<unknown> };
  validateLarkOpenIds: (normalized: Record<string, unknown>) => {
    errors: Array<unknown>;
    warnings: Array<unknown>;
  };
  probeExecutable: (command: string) => { ok: boolean; mode: string; detail: string };
};

let tempDirs: string[] = [];
let originalEnv: NodeJS.ProcessEnv;

async function loadCore(): Promise<PreflightCore> {
  return await import(pathToFileURL(preflightCorePath).href) as PreflightCore;
}

async function makeTempDir(prefix = 'manager-preflight-core-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function writePackageFixture(cwd: string) {
  await writeJson(path.join(cwd, 'package.json'), {
    name: 'manager-preflight-core-fixture',
    version: '1.0.0',
    type: 'module',
    scripts: {},
  });
}

function toDetails(items: Array<unknown>) {
  return items.map((item) => JSON.stringify(item)).join('\n');
}

function validConfig(cwd: string, overrides: Record<string, unknown> = {}) {
  const commandRoles = {
    architect: 'codexAgent',
    planReviewer: 'codexAgent',
    developer: 'codexAgent',
    finalReviewer: 'codexAgent',
  };
  const config = {
    workspace: {
      targetDir: path.join(cwd, 'workspace'),
    },
    defaultProjectId: 'main',
    projects: [
      {
        id: 'main',
        targetDir: path.join(cwd, 'project'),
      },
    ],
    profiles: {
      assistant: {
        kind: 'openai-compatible',
        model: 'gpt-test',
        baseUrl: 'https://api.example.test/v1',
        apiKeyEnv: 'ASSISTANT_API_KEY',
      },
      roleAgent: {
        kind: 'openai-compatible',
        model: 'role-test',
        baseUrl: 'https://api.example.test/v1',
        apiKeyEnv: 'ROLE_AGENT_API_KEY',
      },
      codexAgent: {
        kind: 'codex',
        command: 'node',
      },
    },
    workflowRoles: {
      assistant: 'assistant',
      low: commandRoles,
      medium: commandRoles,
      high: commandRoles,
    },
    lark: {
      appIdEnv: 'LARK_APP_ID',
      appSecretEnv: 'LARK_APP_SECRET',
      allowedOpenIds: ['ou_real_open_id_12345'],
    },
  };

  return {
    ...config,
    ...overrides,
  };
}

async function writeConfigFixture(cwd: string, config = validConfig(cwd)) {
  const configPath = path.join(cwd, 'assistant.config.local.json');
  await writeJson(configPath, config);
  return configPath;
}

async function makeExecutable(filePath: string) {
  const script = process.platform === 'win32'
    ? '@echo off\r\nexit /b 0\r\n'
    : '#!/usr/bin/env sh\nexit 0\n';
  await writeFile(filePath, script, 'utf8');
  await chmod(filePath, 0o755);
}

function pathEnvKey() {
  return process.platform === 'win32' ? 'Path' : 'PATH';
}

function withPathPrefix<T>(dir: string, run: () => T) {
  const key = pathEnvKey();
  const previous = process.env[key];
  const previousUpper = process.env.PATH;
  process.env[key] = `${dir}${path.delimiter}${previous ?? ''}`;
  if (process.platform === 'win32') {
    process.env.PATH = process.env[key];
  }

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
    if (process.platform === 'win32') {
      if (previousUpper === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousUpper;
      }
    }
  }
}

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('preflightCore parseEnvFile', () => {
  it('mirrors runtime .env parsing for comments, quotes, empty values, export, and invalid keys', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();
    const envPath = path.join(dir, '.env.local');
    await writeFile(envPath, [
      '# comment',
      '',
      'ASSISTANT_API_KEY=sk-assistant',
      'EMPTY=',
      'export LARK_APP_ID="cli_real_app"',
      "export LARK_APP_SECRET='secret with spaces'",
      'ROLE_AGENT_API_KEY=sk-role',
      '1FOO=bad',
      'FOO BAR=bad',
      'NO_EQUALS',
      '',
    ].join('\n'), 'utf8');

    const parsed = await core.parseEnvFile(envPath);

    expect(parsed.exists).toBe(true);
    expect(parsed.vars.get('ASSISTANT_API_KEY')).toBe('sk-assistant');
    expect(parsed.vars.get('EMPTY')).toBe('');
    expect(parsed.vars.get('LARK_APP_ID')).toBe('cli_real_app');
    expect(parsed.vars.get('LARK_APP_SECRET')).toBe('secret with spaces');
    expect(parsed.vars.get('ROLE_AGENT_API_KEY')).toBe('sk-role');
    expect(parsed.vars.has('1FOO')).toBe(false);
    expect(parsed.vars.has('FOO BAR')).toBe(false);
  });

  it('treats export-prefixed env files as valid input without exposing values', async () => {
    const dir = await makeTempDir();
    const envPath = path.join(dir, '.env.local');
    const configPath = await writeConfigFixture(dir);
    await writePackageFixture(dir);
    await writeFile(envPath, [
      'export ASSISTANT_API_KEY=sk-export-assistant-secret',
      'export ROLE_AGENT_API_KEY=sk-export-role-secret',
      'export LARK_APP_ID="cli_real_export"',
      "export LARK_APP_SECRET='secret export value'",
    ].join('\n'), 'utf8');

    const result = spawnSync(process.execPath, [
      '--',
      path.join(repoRoot, 'scripts', 'preflight.mjs'),
      '--config',
      configPath,
      '--env-file',
      envPath,
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ASSISTANT_API_KEY: undefined,
        ROLE_AGENT_API_KEY: undefined,
        LARK_APP_ID: undefined,
        LARK_APP_SECRET: undefined,
      },
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('sk-export-assistant-secret');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('secret export value');
  });
});

describe('preflightCore config-derived contracts', () => {
  it('dedupes required env names from assistant, workflow role profiles, and lark', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();
    const configPath = await writeConfigFixture(dir, {
      ...validConfig(dir),
      profiles: {
        assistant: {
          kind: 'openai-compatible',
          model: 'gpt-test',
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: 'ASSISTANT_API_KEY',
        },
        roleOne: {
          kind: 'openai-compatible',
          model: 'role-test',
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: 'ROLE_AGENT_API_KEY',
        },
        roleTwo: {
          kind: 'openai-compatible',
          model: 'role-test-2',
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: 'ROLE_AGENT_API_KEY',
        },
        commandOnly: {
          kind: 'command',
          command: 'node',
        },
      },
      workflowRoles: {
        assistant: 'assistant',
        low: {
          architect: 'roleOne',
          planReviewer: 'commandOnly',
          developer: 'commandOnly',
          finalReviewer: 'roleTwo',
        },
        medium: {
          architect: 'commandOnly',
          planReviewer: 'roleOne',
          developer: 'commandOnly',
          finalReviewer: 'roleTwo',
        },
        high: {
          architect: 'roleTwo',
          planReviewer: 'commandOnly',
          developer: 'roleOne',
          finalReviewer: 'commandOnly',
        },
      },
    });
    const loaded = await core.loadConfig({ explicitPath: configPath, cwd: dir });

    const names = core.collectRequiredEnvNames(loaded.normalized);

    expect(names.apiKeyEnvs.sort()).toEqual(['ASSISTANT_API_KEY', 'ROLE_AGENT_API_KEY']);
    expect(names.larkEnvs.sort()).toEqual(['LARK_APP_ID', 'LARK_APP_SECRET']);
    expect(JSON.stringify(names.byProfile)).toContain('assistant');
    expect(JSON.stringify(names.byProfile)).not.toContain('commandOnly');
  });

  it('keeps raw npmScript metadata before normalization', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();
    const configPath = await writeConfigFixture(dir, {
      ...validConfig(dir),
      profiles: {
        scripted: {
          kind: 'command',
          npmScript: 'agent:scripted',
        },
      },
      workflowRoles: {
        assistant: 'scripted',
        low: {
          architect: 'scripted',
          planReviewer: 'scripted',
          developer: 'scripted',
          finalReviewer: 'scripted',
        },
        medium: {
          architect: 'scripted',
          planReviewer: 'scripted',
          developer: 'scripted',
          finalReviewer: 'scripted',
        },
        high: {
          architect: 'scripted',
          planReviewer: 'scripted',
          developer: 'scripted',
          finalReviewer: 'scripted',
        },
      },
    });

    const loaded = await core.loadConfig({ explicitPath: configPath, cwd: dir });

    expect(loaded.rawProfileMeta.scripted).toMatchObject({
      rawNpmScript: 'agent:scripted',
    });
  });

  it('uses an empty workspace base instead of leaking runtime default paths', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();
    const configPath = await writeConfigFixture(dir, {
      ...validConfig(dir),
      workspace: {},
    });
    const loaded = await core.loadConfig({ explicitPath: configPath, cwd: dir });

    expect(JSON.stringify(loaded.normalized)).not.toContain('E:/GameDeveloping/IReader/my-reader');
    expect(core.validateWorkspacePaths(loaded.normalized).errors).not.toEqual([]);
  });
});

describe('preflightCore validation helpers', () => {
  it('rejects placeholder values used in example configuration files', async () => {
    const core = await loadCore();

    for (const value of [
      '',
      '   ',
      'replace_me',
      'xxx',
      'cli_xxx',
      'your_api_key_here',
      'your_workspace_here',
      'ou_your_open_id_here',
    ]) {
      expect(core.isPlaceholderValue(value), value).toBe(true);
    }
    expect(core.isPlaceholderValue('sk-realistic-test-value')).toBe(false);
  });

  it('accepts normalized deepseek assistant and command-backed workflow roles', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();
    const configPath = await writeConfigFixture(dir, {
      ...validConfig(dir),
      profiles: {
        assistant: {
          kind: 'deepseek',
          model: 'deepseek-chat',
          baseUrl: 'https://api.deepseek.example/v1',
          apiKeyEnv: 'ASSISTANT_API_KEY',
        },
        codexAgent: {
          kind: 'codex',
          command: 'node',
        },
        claudeAgent: {
          kind: 'claude',
          command: 'node',
        },
        commandByShape: {
          command: 'node',
        },
      },
      workflowRoles: {
        assistant: 'assistant',
        low: {
          architect: 'codexAgent',
          planReviewer: 'claudeAgent',
          developer: 'commandByShape',
          finalReviewer: 'codexAgent',
        },
        medium: {
          architect: 'claudeAgent',
          planReviewer: 'commandByShape',
          developer: 'codexAgent',
          finalReviewer: 'claudeAgent',
        },
        high: {
          architect: 'commandByShape',
          planReviewer: 'codexAgent',
          developer: 'commandByShape',
          finalReviewer: 'claudeAgent',
        },
      },
    });
    const loaded = await core.loadConfig({ explicitPath: configPath, cwd: dir });

    const result = core.validateProfiles(loaded.normalized, loaded.rawProfileMeta);

    expect(result.errors).toEqual([]);
    expect((loaded.normalized.workflowRoles as Record<string, Record<string, string>>)['extra-high'].developer)
      .toBe('commandByShape');
  });

  it('fails workspace/project paths that are missing, placeholder, or reference unknown defaultProjectId', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();

    const missingWorkspacePath = await writeConfigFixture(dir, {
      ...validConfig(dir),
      workspace: {},
    });
    const missingWorkspace = await core.loadConfig({ explicitPath: missingWorkspacePath, cwd: dir });
    expect(toDetails(core.validateWorkspacePaths(missingWorkspace.normalized).errors)).toContain('workspace');

    const placeholderPath = await writeConfigFixture(dir, {
      ...validConfig(dir),
      workspace: { targetDir: 'your_path_here' },
      projects: [{ id: 'main', targetDir: 'replace_me' }],
    });
    const placeholder = await core.loadConfig({ explicitPath: placeholderPath, cwd: dir });
    expect(toDetails(core.validateWorkspacePaths(placeholder.normalized).errors)).toContain('placeholder');

    const badDefaultPath = await writeConfigFixture(dir, {
      ...validConfig(dir),
      defaultProjectId: 'missing-project',
    });
    const badDefault = await core.loadConfig({ explicitPath: badDefaultPath, cwd: dir });
    expect(toDetails(core.validateWorkspacePaths(badDefault.normalized).errors)).toContain('defaultProjectId');

    const validPath = await writeConfigFixture(dir, validConfig(dir));
    const valid = await core.loadConfig({ explicitPath: validPath, cwd: dir });
    expect(core.validateWorkspacePaths(valid.normalized).errors).toEqual([]);
  });

  it('validates Lark allowed open IDs', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();

    const emptyPath = await writeConfigFixture(dir, {
      ...validConfig(dir),
      lark: {
        appIdEnv: 'LARK_APP_ID',
        appSecretEnv: 'LARK_APP_SECRET',
        allowedOpenIds: [],
      },
    });
    const empty = await core.loadConfig({ explicitPath: emptyPath, cwd: dir });
    expect(core.validateLarkOpenIds(empty.normalized).errors).not.toEqual([]);

    const placeholderPath = await writeConfigFixture(dir, {
      ...validConfig(dir),
      lark: {
        appIdEnv: 'LARK_APP_ID',
        appSecretEnv: 'LARK_APP_SECRET',
        allowedOpenIds: ['ou_your_open_id_here'],
      },
    });
    const placeholder = await core.loadConfig({ explicitPath: placeholderPath, cwd: dir });
    expect(toDetails(core.validateLarkOpenIds(placeholder.normalized).errors)).toContain('placeholder');

    const validPath = await writeConfigFixture(dir, validConfig(dir));
    const valid = await core.loadConfig({ explicitPath: validPath, cwd: dir });
    expect(core.validateLarkOpenIds(valid.normalized).errors).toEqual([]);
  });

  it('lets an empty process.env value override a valid env-file value', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();
    const envPath = path.join(dir, '.env.local');
    await writeFile(envPath, 'ASSISTANT_API_KEY=sk-from-file\n', 'utf8');
    const parsed = await core.parseEnvFile(envPath);

    process.env.ASSISTANT_API_KEY = '';
    const effective = core.effectiveEnvValue('ASSISTANT_API_KEY', parsed);

    expect(effective.value).toBe('');
    expect(effective.source).toBe('process.env');
    expect(core.isPlaceholderValue(effective.value)).toBe(true);
  });
});

describe('preflightCore probeExecutable', () => {
  it('fails empty commands and resolves bare commands through PATH', async () => {
    const core = await loadCore();

    expect(core.probeExecutable('   ').ok).toBe(false);
    expect(core.probeExecutable('node').ok).toBe(true);
  });

  it('resolves bare dotted commands through PATH', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();
    const binDir = path.join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    await makeExecutable(path.join(binDir, 'fake-agent.cmd'));

    const result = withPathPrefix(binDir, () => core.probeExecutable('fake-agent.cmd'));

    expect(result.ok).toBe(true);
  });

  it('resolves node.exe through PATH on Windows', async () => {
    const core = await loadCore();

    if (process.platform !== 'win32') {
      expect(core.probeExecutable('node').ok).toBe(true);
      return;
    }

    expect(core.probeExecutable('node.exe').ok).toBe(true);
  });

  it('accepts quoted absolute paths with spaces', async () => {
    const core = await loadCore();
    const dir = await makeTempDir();
    const binDir = path.join(dir, 'dir with spaces');
    await mkdir(binDir, { recursive: true });
    const executablePath = path.join(binDir, process.platform === 'win32' ? 'fake tool.cmd' : 'fake-tool');
    await makeExecutable(executablePath);

    const result = core.probeExecutable(`"${executablePath}"`);

    expect(result.ok).toBe(true);
  });

  it('checks Windows executable siblings for path-like commands', async () => {
    const core = await loadCore();

    if (process.platform !== 'win32') {
      expect(core.probeExecutable(process.execPath).ok).toBe(true);
      return;
    }

    const dir = await makeTempDir();
    const stem = path.join(dir, 'path-like-tool');
    await makeExecutable(`${stem}.cmd`);

    expect(core.probeExecutable(stem).ok).toBe(true);
  });
});
