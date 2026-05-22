import { execFile } from 'node:child_process';

import { sanitizeTextForArtifact } from './textSanitizer.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runFile(command: string, args: string[], cwd: string, input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
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
      const cleanStdout = sanitizeTextForArtifact(stdout);
      const cleanStderr = sanitizeTextForArtifact(stderr);
      if (error) {
        const errInfo = `[runFile error: ${error.message}${(error as NodeJS.ErrnoException).code ? ` (${(error as NodeJS.ErrnoException).code})` : ''}]`;
        resolve({ code: 1, stdout: cleanStdout, stderr: cleanStderr ? `${cleanStderr}\n${errInfo}` : errInfo });
        return;
      }
      resolve({ code: 0, stdout: cleanStdout, stderr: cleanStderr });
    });

    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}
