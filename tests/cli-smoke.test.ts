import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(__dirname, '..');
const CLI_ENTRY = resolve(REPO_ROOT, 'dist', 'cli.js');

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-smoke-target-'));
  await execFileAsync('git', ['init'], { cwd: dir });
  return dir;
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(configPath: string, args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args, '--config', configPath],
      { cwd: REPO_ROOT, env: process.env, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({
          stdout: String(stdout),
          stderr: String(stderr),
          code: error && 'code' in error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : (error ? 1 : 0),
        });
      },
    );
  });
}

async function makeTempConfig(targetDir: string, artifactsDir: string): Promise<string> {
  const configPath = join(artifactsDir, 'cli-smoke.config.json');
  const config = {
    workspace: { targetDir },
    defaultProjectId: 'smoke',
    projects: [{
      id: 'smoke',
      name: 'Smoke',
      targetDir,
      docsDir: join(artifactsDir, 'project-docs'),
      taskRecordRoot: join(targetDir, 'task'),
      alwaysRead: [],
    }],
    artifactsDir,
    maxRevisionRounds: 3,
    workflowRoles: {
      assistant: 'assistant-api',
      low: { architect: 'architect-agent', planReviewer: 'plan-reviewer-agent', developer: 'developer-agent', finalReviewer: 'final-reviewer-agent' },
      medium: { architect: 'architect-agent', planReviewer: 'plan-reviewer-agent', developer: 'developer-agent', finalReviewer: 'final-reviewer-agent' },
      high: { architect: 'architect-agent', planReviewer: 'plan-reviewer-agent', developer: 'developer-agent', finalReviewer: 'final-reviewer-agent' },
      'extra-high': { architect: 'architect-agent', planReviewer: 'plan-reviewer-agent', developer: 'developer-agent', finalReviewer: 'final-reviewer-agent' },
    },
    profiles: {
      'assistant-api': { kind: 'openai-compatible', apiKeyEnv: 'NEVER_SET_API_KEY' },
      'architect-agent': { kind: 'command' },
      'plan-reviewer-agent': { kind: 'command' },
      'developer-agent': { kind: 'command' },
      'final-reviewer-agent': { kind: 'command' },
    },
    verification: { allowlist: ['npm test'] },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

describe('CLI smoke (zero-token)', () => {
  it('prints help when no command is given', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-smoke-root-'));
    try {
      const targetDir = await makeGitRepo();
      try {
        const configPath = await makeTempConfig(targetDir, root);
        const result = await runCli(configPath, ['help']);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Assistant workflow orchestrator');
        expect(result.stdout).toContain('plan --task latest');
        expect(result.stdout).toContain('--allow-agent-calls');
      } finally {
        await rm(targetDir, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs create -> plan (difficulty gate) -> status -> show, all without --allow-agent-calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-smoke-root-'));
    try {
      const targetDir = await makeGitRepo();
      try {
        const configPath = await makeTempConfig(targetDir, root);

        const created = await runCli(configPath, ['create', '--title', 'Smoke task', '--task', 'Add a CLI smoke harness.']);
        expect(created.code).toBe(0);
        expect(created.stdout).toContain('Status: created');

        const planned = await runCli(configPath, ['plan', '--task', 'latest']);
        expect(planned.code).toBe(0);
        expect(planned.stdout).toContain('Status: awaiting_difficulty_selection');
        // The pendingUserPrompt for the difficulty gate is included in the message.
        expect(planned.stdout.toLowerCase()).toContain('low');
        expect(planned.stdout.toLowerCase()).toContain('medium');
        expect(planned.stdout.toLowerCase()).toContain('high');

        const status = await runCli(configPath, ['status', '--task', 'latest']);
        expect(status.code).toBe(0);
        expect(status.stdout).toContain('Smoke task');
        expect(status.stdout).toContain('awaiting_difficulty_selection');

        const show = await runCli(configPath, ['show', '--task', 'latest', '--artifact', 'original-task']);
        expect(show.code).toBe(0);
        expect(show.stdout).toContain('Add a CLI smoke harness.');

        // Difficulty selection is where the zero-token CLI surface ends: low triggers Stub
        // heavy planning, but the real assistant adapter is still invoked for explanation
        // and requires an API key. Verify that the CLI surfaces that error cleanly instead
        // of crashing the harness.
        const replied = await runCli(configPath, ['reply', '--task', 'latest', 'low']);
        expect(replied.code).not.toBe(0);
        // Either the assistant adapter complains about missing API config OR profile/baseUrl.
        expect(replied.stderr.toLowerCase()).toMatch(/assistant|api key|baseurl|profile/);
      } finally {
        await rm(targetDir, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it('rejects unknown commands with a clear error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-smoke-root-'));
    try {
      const targetDir = await makeGitRepo();
      try {
        const configPath = await makeTempConfig(targetDir, root);
        const result = await runCli(configPath, ['banana']);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('Unknown command: banana');
      } finally {
        await rm(targetDir, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
