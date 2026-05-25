import { exec } from 'node:child_process';

import { sanitizeTextForArtifact } from './textSanitizer.js';
import type { VerificationCommandResult } from './types.js';

const BLOCKED_BY_POLICY_OUTPUT = 'Blocked by verification command policy.';
const SHELL_SYNTAX_PATTERN = /[\r\n;&|<>`]/;
const SHELL_EXPANSION_PATTERN = /\$\s*\(|\$\{/;
const SAFE_ARGUMENT_PATTERN = /^[A-Za-z0-9._/@:=,+\\-]+$/;
const UNSAFE_ARGUMENTS = new Set([
  'rm',
  'rmdir',
  'del',
  'erase',
  'rd',
  'remove-item',
  'mv',
  'move',
  'cp',
  'copy',
  'git',
  'curl',
  'wget',
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'sh',
  'node',
  'tsx',
  'ts-node',
  '--fix',
  '--write',
  '--watch',
  '--watchall',
  '--interactive',
  '--updatesnapshot',
  '-u',
]);

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function normalizedAllowlist(allowlist: string[]): Set<string> {
  return new Set(allowlist.map(normalizeCommand).filter(Boolean));
}

function hasUnsafeShellSyntax(command: string): boolean {
  return SHELL_SYNTAX_PATTERN.test(command) || SHELL_EXPANSION_PATTERN.test(command);
}

function isSafeArgument(argument: string): boolean {
  const lower = argument.toLowerCase();
  if (UNSAFE_ARGUMENTS.has(lower)) return false;
  if (lower.startsWith('--watch') || lower.startsWith('--inspect') || lower.startsWith('--debug')) return false;
  return SAFE_ARGUMENT_PATTERN.test(argument);
}

function hasSafePassThroughArgs(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args[0] !== '--') return false;
  return args.length > 1 && args.slice(1).every(isSafeArgument);
}

function isAllowlistedNpmVariant(tokens: string[], allowlist: Set<string>): boolean {
  if (tokens[0] === 'npm' && tokens[1] === 'test' && allowlist.has('npm test')) {
    return hasSafePassThroughArgs(tokens.slice(2));
  }

  if (tokens[0] === 'npm' && tokens[1] === 'run' && tokens[2]) {
    const baseCommand = normalizeCommand(tokens.slice(0, 3).join(' '));
    if (allowlist.has(baseCommand)) {
      return hasSafePassThroughArgs(tokens.slice(3));
    }
  }

  return false;
}

function isAllowlistedTscVariant(tokens: string[], allowlist: Set<string>): boolean {
  if (tokens[0] === 'tsc' && tokens[1] === '--noEmit' && allowlist.has('tsc --noEmit')) {
    return tokens.slice(2).every(isSafeArgument);
  }

  if (
    tokens[0] === 'npx'
    && tokens[1] === 'tsc'
    && tokens[2] === '--noEmit'
    && allowlist.has('npx tsc --noEmit')
  ) {
    return tokens.slice(3).every(isSafeArgument);
  }

  return false;
}

export function isCommandAllowed(command: string, allowlist: string[]): boolean {
  if (hasUnsafeShellSyntax(command)) return false;

  const normalized = normalizeCommand(command);
  const allowed = normalizedAllowlist(allowlist);
  if (allowed.has(normalized)) return true;

  const tokens = normalized.split(' ');
  return isAllowlistedNpmVariant(tokens, allowed) || isAllowlistedTscVariant(tokens, allowed);
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
        output: BLOCKED_BY_POLICY_OUTPUT,
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
