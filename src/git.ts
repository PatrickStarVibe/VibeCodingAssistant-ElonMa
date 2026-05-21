import type { GitSnapshot } from './types.js';
import { runFile } from './processRunner.js';

export async function readGitSnapshot(targetDir: string): Promise<GitSnapshot> {
  const status = await runFile('git', ['-C', targetDir, 'status', '--short'], targetDir);
  const diff = await runFile('git', ['-C', targetDir, 'diff', '--no-ext-diff'], targetDir);
  return {
    statusShort: status.stdout.trim(),
    diff: diff.stdout,
  };
}

export function statusLines(snapshot: GitSnapshot): string[] {
  return snapshot.statusShort.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

export function diffStatusLines(before: GitSnapshot, after: GitSnapshot): string[] {
  const beforeLines = new Set(statusLines(before));
  return statusLines(after).filter((line) => !beforeLines.has(line));
}
