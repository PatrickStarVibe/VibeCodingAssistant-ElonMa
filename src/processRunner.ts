import { execFile } from 'node:child_process';

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
      maxBuffer: 20 * 1024 * 1024,
      shell: isWindows,
    }, (error, stdout, stderr) => {
      if (error) {
        const errInfo = `[runFile error: ${error.message}${(error as NodeJS.ErrnoException).code ? ` (${(error as NodeJS.ErrnoException).code})` : ''}]`;
        resolve({ code: 1, stdout, stderr: stderr ? `${stderr}\n${errInfo}` : errInfo });
        return;
      }
      resolve({ code: 0, stdout, stderr });
    });

    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}
