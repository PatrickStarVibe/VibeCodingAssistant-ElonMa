/*
 * CLI tests for Manager distribution preflight, setup, and Windows launcher entry points.
 * Uses temporary fixture workspaces and spawned Node processes to verify user-facing behavior.
 * Author: Manager distribution tooling
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const preflightScript = path.join(repoRoot, 'scripts', 'preflight.mjs');
const setupScript = path.join(repoRoot, 'scripts', 'setup.mjs');

type SpawnResult = ReturnType<typeof spawnSync>;

let tempDirs: string[] = [];

const managedEnvNames = [
  'ASSISTANT_API_KEY',
  'ROLE_AGENT_API_KEY',
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  'MANAGER_API_KEY',
  'MANAGER_AGENT_ID',
];

async function makeTempDir(prefix = 'manager-preflight-cli-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, data: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function writePackageFixture(cwd: string, scripts: Record<string, string> = {}) {
  await writeJson(path.join(cwd, 'package.json'), {
    name: 'manager-preflight-fixture',
    version: '1.2.3',
    type: 'module',
    scripts: {
      'agent:scripted': 'node -e "process.exit(0)"',
      ...scripts,
    },
  });
  await writeJson(path.join(cwd, 'package-lock.json'), {
    name: 'manager-preflight-fixture',
    lockfileVersion: 3,
    packages: {},
  });
}

async function writeEnvFile(cwd: string, fileName = '.env.local') {
  const envPath = path.join(cwd, fileName);
  await writeFile(envPath, [
    'ASSISTANT_API_KEY=sk-assistant-fixture',
    'ROLE_AGENT_API_KEY=sk-role-fixture',
    'LARK_APP_ID=cli_real_fixture',
    'LARK_APP_SECRET=secret-fixture',
    '',
  ].join('\n'), 'utf8');
  return envPath;
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

async function writeLocalConfig(cwd: string, config = validConfig(cwd)) {
  const configPath = path.join(cwd, 'assistant.config.local.json');
  await writeJson(configPath, config);
  return configPath;
}

async function writeExampleConfig(cwd: string, config = validConfig(cwd)) {
  const configPath = path.join(cwd, 'assistant.config.example.json');
  await writeJson(configPath, config);
  return configPath;
}

function cleanEnv(overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of managedEnvNames) {
    delete env[name];
  }

  return {
    ...env,
    ...overrides,
  };
}

function runNode(scriptPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnv()) {
  return spawnSync(process.execPath, ['--', scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

function runPreflight(cwd: string, args: string[] = [], env: NodeJS.ProcessEnv = cleanEnv()) {
  return runNode(preflightScript, args, cwd, env);
}

function parseStdoutJson(result: SpawnResult) {
  expect(result.stderr ?? '').toBe('');
  expect(result.stdout).toBeTruthy();
  return JSON.parse(String(result.stdout));
}

function allOutput(result: SpawnResult) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

async function makeRunnableFixture() {
  const dir = await makeTempDir();
  await writePackageFixture(dir);
  await writeLocalConfig(dir);
  await writeEnvFile(dir);
  return dir;
}

async function readRuntimeDefaultTargetDir() {
  const configPath = path.join(repoRoot, 'src', 'config.ts');
  try {
    const mod = await import(pathToFileURL(configPath).href) as {
      defaultConfig?: () => { workspace?: { targetDir?: string } };
    };
    return mod.defaultConfig?.().workspace?.targetDir ?? null;
  } catch {
    return null;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('preflight.mjs config source behavior', () => {
  it('fails by default when only assistant.config.example.json exists', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeExampleConfig(dir);
    await writeEnvFile(dir);

    const result = runPreflight(dir, ['--json']);
    const payload = parseStdoutJson(result);

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload.checks)).toContain('config-source');
    expect(JSON.stringify(payload.checks)).toContain('assistant.config.example.json');
  });

  it('proceeds when assistant.config.example.json is passed explicitly', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    const configPath = await writeExampleConfig(dir);
    await writeEnvFile(dir);

    const result = runPreflight(dir, ['--config', configPath, '--json']);
    const payload = parseStdoutJson(result);

    expect(result.status).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.sourceKind).toBe('explicit');
  });

  it('fails when neither local nor example config exists', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeEnvFile(dir);

    const result = runPreflight(dir, ['--json']);
    const payload = parseStdoutJson(result);

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload.checks)).toContain('no assistant.config.local.json');
  });

  it('succeeds with a launchable assistant.config.local.json', async () => {
    const dir = await makeRunnableFixture();

    const result = runPreflight(dir, ['--json']);
    const payload = parseStdoutJson(result);

    expect(result.status).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.sourceKind).toBe('local');
  });

  it('emits JSON-only output for a missing explicit config path', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeEnvFile(dir);

    const missingPath = path.join(dir, 'does-not-exist.json');
    const result = runPreflight(dir, ['--config', missingPath, '--json']);
    const payload = parseStdoutJson(result);

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload.checks)).toContain('config-source');
    expect(JSON.stringify(payload.checks)).toContain(path.basename(missingPath));
  });
});

describe('preflight.mjs env-file behavior', () => {
  it('fails with a named check when --env-file points to a missing file in human mode', async () => {
    const dir = await makeRunnableFixture();
    const missingPath = path.join(dir, 'does-not-exist.env');

    const result = runPreflight(dir, ['--env-file', missingPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Environment file');
    expect(result.stdout).toContain(path.basename(missingPath));
    expect(allOutput(result)).not.toContain('sk-assistant-fixture');
  });

  it('fails with parseable JSON when --env-file points to a missing file', async () => {
    const dir = await makeRunnableFixture();
    const missingPath = path.join(dir, 'does-not-exist.env');

    const result = runPreflight(dir, ['--env-file', missingPath, '--json']);
    const payload = parseStdoutJson(result);

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload.checks)).toContain('env-file');
    expect(JSON.stringify(payload.checks)).toContain(path.basename(missingPath));
  });

  it('accepts a non-default env file while warning that runtime still loads .env.local', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeLocalConfig(dir);
    const customEnvPath = await writeEnvFile(dir, 'custom.env');

    const result = runPreflight(dir, ['--env-file', customEnvPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('runtime still loads .env.local');
  });
});

describe('preflight.mjs profile-wide command and npmScript checks', () => {
  it('fails when an unreferenced profile has an unresolvable command', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeLocalConfig(dir, {
      ...validConfig(dir),
      profiles: {
        ...(validConfig(dir).profiles as Record<string, unknown>),
        orphan: {
          kind: 'command',
          command: 'definitely-missing-cli',
        },
      },
    });
    await writeEnvFile(dir);

    const result = runPreflight(dir, ['--json']);
    const payload = parseStdoutJson(result);
    const details = JSON.stringify(payload.checks);

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(details).toContain('orphan');
    expect(details).toContain('unreferenced');
    expect(details).toContain('definitely-missing-cli');
  });

  it('fails when an unreferenced profile has a missing npmScript', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeLocalConfig(dir, {
      ...validConfig(dir),
      profiles: {
        ...(validConfig(dir).profiles as Record<string, unknown>),
        orphanScript: {
          kind: 'command',
          command: 'node',
          npmScript: 'missing:script',
        },
      },
    });
    await writeEnvFile(dir);

    const result = runPreflight(dir, ['--json']);
    const payload = parseStdoutJson(result);
    const details = JSON.stringify(payload.checks);

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(details).toContain('orphanScript');
    expect(details).toContain('missing:script');
  });

  it('fails when a referenced workflow-role profile has a missing command', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeLocalConfig(dir, {
      ...validConfig(dir),
      profiles: {
        ...(validConfig(dir).profiles as Record<string, unknown>),
        codexAgent: {
          kind: 'codex',
          command: 'definitely-missing-cli',
        },
      },
    });
    await writeEnvFile(dir);

    const result = runPreflight(dir, ['--json']);
    const payload = parseStdoutJson(result);
    const details = JSON.stringify(payload.checks);

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(details).toContain('codexAgent');
    expect(details).toContain('definitely-missing-cli');
    expect(details).not.toContain("unreferenced profile 'codexAgent'");
  });
});

describe('preflight.mjs JSON and doctor output', () => {
  it('emits parseable JSON for malformed config files', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeEnvFile(dir);
    await writeFile(path.join(dir, 'assistant.config.local.json'), '{ invalid json', 'utf8');

    const result = runPreflight(dir, ['--json']);
    const payload = parseStdoutJson(result);

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
  });

  it('emits parseable JSON for bad CLI args when --json is present', async () => {
    const dir = await makeTempDir();

    const result = runPreflight(dir, ['--unknown-flag', '--json']);
    const payload = parseStdoutJson(result);

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
  });

  it('includes an environment block in doctor JSON output', async () => {
    const dir = await makeRunnableFixture();

    const result = runPreflight(dir, ['--doctor', '--json']);
    const payload = parseStdoutJson(result);

    expect(result.status).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.environment).toBeTruthy();
  });
});

describe('preflight.mjs env-var contract', () => {
  it('requires apiKeyEnv names derived from config rather than MANAGER_* names', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeLocalConfig(dir, {
      ...validConfig(dir),
      profiles: {
        assistant: {
          kind: 'openai-compatible',
          model: 'gpt-test',
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: 'ASSISTANT_API_KEY',
        },
      },
      workflowRoles: {
        assistant: 'assistant',
        low: {
          architect: 'codexAgent',
          planReviewer: 'codexAgent',
          developer: 'codexAgent',
          finalReviewer: 'codexAgent',
        },
        medium: {
          architect: 'codexAgent',
          planReviewer: 'codexAgent',
          developer: 'codexAgent',
          finalReviewer: 'codexAgent',
        },
        high: {
          architect: 'codexAgent',
          planReviewer: 'codexAgent',
          developer: 'codexAgent',
          finalReviewer: 'codexAgent',
        },
      },
    });
    await writeFile(path.join(dir, '.env.local'), [
      'LARK_APP_ID=cli_real_fixture',
      'LARK_APP_SECRET=secret-fixture',
      '',
    ].join('\n'), 'utf8');

    const result = runPreflight(dir, ['--json']);
    const payload = parseStdoutJson(result);
    const details = JSON.stringify(payload.checks);

    expect(result.status).toBe(1);
    expect(details).toContain('ASSISTANT_API_KEY');
    expect(details).not.toContain('MANAGER_API_KEY');
    expect(details).not.toContain('MANAGER_AGENT_ID');
  });

  it('passes without MANAGER_* variables when config references different env names', async () => {
    const dir = await makeRunnableFixture();

    const result = runPreflight(dir);

    expect(result.status).toBe(0);
    expect(allOutput(result)).not.toContain('MANAGER_API_KEY');
    expect(allOutput(result)).not.toContain('MANAGER_AGENT_ID');
  });
});

describe('setup.mjs non-interactive mode', () => {
  it('is idempotent, exits on remaining placeholders, avoids value logging, and does not leak runtime default paths', async () => {
    const dir = await makeTempDir();
    await writePackageFixture(dir);
    await writeFile(path.join(dir, '.env.example'), [
      'ASSISTANT_API_KEY=sk-setup-secret',
      'ROLE_AGENT_API_KEY=sk-setup-role-secret',
      'LARK_APP_ID=cli_setup_secret',
      'LARK_APP_SECRET=setup-secret-value',
      '',
    ].join('\n'), 'utf8');
    await writeExampleConfig(dir, {
      ...validConfig(dir),
      workspace: {},
      projects: [{ id: 'main', targetDir: 'replace_me' }],
      lark: {
        appIdEnv: 'LARK_APP_ID',
        appSecretEnv: 'LARK_APP_SECRET',
        allowedOpenIds: ['ou_your_open_id_here'],
      },
    });

    const first = runNode(setupScript, ['--non-interactive'], dir);
    const second = runNode(setupScript, ['--non-interactive'], dir);

    expect(first.status).toBe(1);
    expect(second.status).toBe(1);
    expect(allOutput(first)).not.toContain('sk-setup-secret');
    expect(allOutput(first)).not.toContain('setup-secret-value');

    const localConfig = await readFile(path.join(dir, 'assistant.config.local.json'), 'utf8');
    const runtimeDefaultTargetDir = await readRuntimeDefaultTargetDir();
    if (runtimeDefaultTargetDir) {
      expect(localConfig).not.toContain(runtimeDefaultTargetDir);
    }
  });
});

describe('Windows launcher contents', () => {
  it('keeps the batch launcher rooted at the repo and gated on node/npm', async () => {
    const text = await readFile(path.join(repoRoot, 'start-assistant.bat'), 'utf8');
    const lowerText = text.toLowerCase();

    expect(text).toContain('cd /d "%~dp0"');
    expect(text).toContain('where node');
    expect(text).toContain('where npm');
    expect(lowerText).toContain('preflight');
    expect(text).toContain('npm run assistant:start');
  });

  it('keeps the PowerShell launcher rooted at the repo and gated on node/npm', async () => {
    const text = await readFile(path.join(repoRoot, 'start-assistant.ps1'), 'utf8');
    const lowerText = text.toLowerCase();

    expect(text).toContain('Set-Location');
    expect(text).toContain('$PSScriptRoot');
    expect(text).toContain('Get-Command');
    expect(text).toContain('node');
    expect(text).toContain('npm');
    expect(lowerText).toContain('preflight');
    expect(text).toContain('npm run assistant:start');
  });
});
