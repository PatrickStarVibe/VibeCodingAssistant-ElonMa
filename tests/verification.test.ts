import { describe, expect, it } from 'vitest';

import { DEFAULT_VERIFICATION_ALLOWLIST } from '../src/config.js';
import { isCommandAllowed, runVerificationCommands } from '../src/verification.js';

describe('verification allowlist', () => {
  it('allows only exact normalized commands from the configured allowlist', () => {
    expect(isCommandAllowed('npm test', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed('npm   run   build', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed('rm -rf dist', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(false);
  });

  it('blocks non-allowlisted commands and can skip allowed execution in tests', async () => {
    const results = await runVerificationCommands(
      ['npm test', 'node unsafe-script.js'],
      DEFAULT_VERIFICATION_ALLOWLIST,
      process.cwd(),
      false,
    );

    expect(results).toEqual([
      {
        command: 'npm test',
        status: 'skipped',
        output: 'Skipped because heavy agent calls are not enabled.',
      },
      {
        command: 'node unsafe-script.js',
        status: 'blocked',
        output: 'Blocked by verification allowlist.',
      },
    ]);
  });
});
