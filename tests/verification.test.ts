import { describe, expect, it } from 'vitest';

import { DEFAULT_VERIFICATION_ALLOWLIST } from '../src/config.js';
import { isCommandAllowed, runVerificationCommands } from '../src/verification.js';

describe('verification allowlist', () => {
  it('allows configured verification commands and safe focused variants', () => {
    expect(isCommandAllowed('npm test', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed('npm   run   build', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed(
      'npm test -- src/services/vocabulary/__tests__/feedbackEffectVerification.test.ts',
      DEFAULT_VERIFICATION_ALLOWLIST,
    )).toBe(true);
    expect(isCommandAllowed('npm test -- src/services/vocabulary', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed('npm run test -- tests/verification.test.ts', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed('tsc --noEmit -p tsconfig.json', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(true);
  });

  it('blocks shell syntax and non-verification commands', () => {
    expect(isCommandAllowed('rm -rf dist', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed(
      'npm test -- src/services/vocabulary/__tests__/feedbackEffectVerification.test.ts; rm -rf dist',
      DEFAULT_VERIFICATION_ALLOWLIST,
    )).toBe(false);
    expect(isCommandAllowed('npm test && npm run build', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed('node unsafe-script.js', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed('powershell Remove-Item dist -Recurse', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed('npm test -- --watch', DEFAULT_VERIFICATION_ALLOWLIST)).toBe(false);
  });

  it('blocks unsafe commands and can skip allowed execution in tests', async () => {
    const results = await runVerificationCommands(
      ['npm test -- tests/verification.test.ts', 'node unsafe-script.js'],
      DEFAULT_VERIFICATION_ALLOWLIST,
      process.cwd(),
      false,
    );

    expect(results).toEqual([
      {
        command: 'npm test -- tests/verification.test.ts',
        status: 'skipped',
        output: 'Skipped because heavy agent calls are not enabled.',
      },
      {
        command: 'node unsafe-script.js',
        status: 'blocked',
        output: 'Blocked by verification command policy.',
      },
    ]);
  });
});
