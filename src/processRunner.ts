import { execFile } from 'node:child_process';

import { sanitizeTextForArtifact } from './textSanitizer.js';
import type { BridgeLiveProcessSnapshot, HeavyWorkflowRoleName } from './types.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunFileMetadata {
  taskId?: string;
  role?: HeavyWorkflowRoleName;
  profileName?: string;
  label?: string;
  outputPath?: string;
}

interface ActiveRunRecord extends BridgeLiveProcessSnapshot {
  stdoutTail: string;
  stderrTail: string;
}

const MAX_LIVE_TAIL_CHARS = 8000;
const activeRuns = new Map<string, ActiveRunRecord>();
let nextRunId = 1;

export function runFile(command: string, args: string[], cwd: string, input?: string, metadata: RunFileMetadata = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const runId = `run-${Date.now()}-${nextRunId++}`;
    const startedAt = new Date().toISOString();
    const child = execFile(command, args, {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      maxBuffer: 20 * 1024 * 1024,
      shell: isWindows,
    }, (error, stdout, stderr) => {
      activeRuns.delete(runId);
      const cleanStdout = sanitizeTextForArtifact(stdout);
      const cleanStderr = sanitizeTextForArtifact(stderr);
      if (error) {
        const errInfo = `[runFile error: ${error.message}${(error as NodeJS.ErrnoException).code ? ` (${(error as NodeJS.ErrnoException).code})` : ''}]`;
        resolve({ code: 1, stdout: cleanStdout, stderr: cleanStderr ? `${cleanStderr}\n${errInfo}` : errInfo });
        return;
      }
      resolve({ code: 0, stdout: cleanStdout, stderr: cleanStderr });
    });

    const record: ActiveRunRecord = {
      id: runId,
      command,
      cwd,
      startedAt,
      elapsedMs: 0,
      stdoutTail: '',
      stderrTail: '',
      ...(child.pid ? { pid: child.pid } : {}),
      ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
      ...(metadata.role ? { role: metadata.role } : {}),
      ...(metadata.profileName ? { profileName: metadata.profileName } : {}),
      ...(metadata.label ? { label: metadata.label } : {}),
      ...(metadata.outputPath ? { outputPath: metadata.outputPath } : {}),
    };
    activeRuns.set(runId, record);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      record.stdoutTail = appendTail(record.stdoutTail, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      record.stderrTail = appendTail(record.stderrTail, chunk);
    });

    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

export function getActiveProcessSnapshots(filter: { taskId?: string } = {}): BridgeLiveProcessSnapshot[] {
  const now = Date.now();
  return [...activeRuns.values()]
    .filter((record) => !filter.taskId || record.taskId === filter.taskId)
    .map((record) => {
      const started = Date.parse(record.startedAt);
      return {
        ...record,
        elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
        stdoutTail: sanitizeTextForArtifact(record.stdoutTail).trim(),
        stderrTail: sanitizeTextForArtifact(record.stderrTail).trim(),
      };
    });
}

function appendTail(previous: string, chunk: Buffer | string): string {
  const next = previous + String(chunk);
  return next.length <= MAX_LIVE_TAIL_CHARS ? next : next.slice(-MAX_LIVE_TAIL_CHARS);
}
