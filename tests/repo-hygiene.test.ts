/*
 * CLI tests for the Manager repo hygiene checker.
 * Verifies JSON-only output and named publish-readiness checks for local distribution safeguards.
 * Author: Manager distribution tooling
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const repoHygieneScript = path.join(repoRoot, 'scripts', 'repo-hygiene.mjs');

let tempDirs: string[] = [];

async function makeTempDir(prefix = 'manager-repo-hygiene-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function runRepoHygiene(cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, [repoHygieneScript, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
    windowsHide: true,
  });
}

function parseStdoutJson(result: ReturnType<typeof spawnSync>) {
  expect(result.stderr ?? '').toBe('');
  expect(result.stdout).toBeTruthy();
  return JSON.parse(String(result.stdout));
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('repo-hygiene.mjs', () => {
  it('emits JSON-only output and surfaces missing .gitignore patterns as a named check', async () => {
    const dir = await makeTempDir();
    await writeJson(path.join(dir, 'package.json'), {
      name: 'repo-hygiene-fixture',
      version: '1.2.3',
    });
    await writeJson(path.join(dir, 'package-lock.json'), {
      name: 'repo-hygiene-fixture',
      lockfileVersion: 3,
      packages: {},
    });
    await writeFile(path.join(dir, '.gitignore'), [
      'node_modules/',
      '',
    ].join('\n'), 'utf8');

    const result = runRepoHygiene(dir, ['--json']);
    const payload = parseStdoutJson(result);
    const gitignoreCheck = payload.checks.find((check: { id: string }) => check.id === 'gitignore');

    expect(result.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(gitignoreCheck).toMatchObject({
      id: 'gitignore',
      status: 'fail',
    });
    expect(gitignoreCheck.detail).toContain('.env.local');
    expect(gitignoreCheck.detail).toContain('.env');
  });
});
