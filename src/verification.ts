import { exec } from 'node:child_process';

import { sanitizeTextForArtifact } from './textSanitizer.js';
import type { VerificationCommandResult } from './types.js';

export function isCommandAllowed(command: string, allowlist: string[]): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  return allowlist.some((allowed) => normalized === allowed.trim().replace(/\s+/g, ' '));
}

function runAllowedCommand(command: string, cwd: string): Promise<VerificationCommandResult> {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        command,
        status: error ? 'failed' : 'passed',
        output: sanitizeTextForArtifact([stdout, stderr].filter(Boolean).join('\n')),
      });
    });
  });
}

export async function runVerificationCommands(
  commands: string[],
  allowlist: string[],
  targetDir: string,
  executeAllowed: boolean,
): Promise<VerificationCommandResult[]> {
  const uniqueCommands = [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
  const results: VerificationCommandResult[] = [];

  for (const command of uniqueCommands) {
    if (!isCommandAllowed(command, allowlist)) {
      results.push({
        command,
        status: 'blocked',
        output: 'Blocked by verification allowlist.',
      });
      continue;
    }

    if (!executeAllowed) {
      results.push({
        command,
        status: 'skipped',
        output: 'Skipped because heavy agent calls are not enabled.',
      });
      continue;
    }

    results.push(await runAllowedCommand(command, targetDir));
  }

  return results;
}

export function renderVerificationLog(results: VerificationCommandResult[]): string {
  if (results.length === 0) return 'No verification commands were proposed.';
  return results.map((result) => [
    `## ${result.command}`,
    '',
    `Status: ${result.status}`,
    '',
    '```',
    result.output.trim(),
    '```',
  ].join('\n')).join('\n\n');
}
