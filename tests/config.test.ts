import { describe, expect, it } from 'vitest';

import { defaultConfig, normalizeConfig } from '../src/config.js';

describe('workflow role config', () => {
  it('defaults fixed workflow roles by difficulty', () => {
    const config = defaultConfig();

    expect(config.workflowRoles.low).toEqual({
      architect: 'codex-architect',
      planReviewer: 'codex-plan-reviewer',
      developer: 'codex-developer',
      finalReviewer: 'codex-final-reviewer',
    });
    expect(config.workflowRoles.medium).toEqual({
      architect: 'codex-architect',
      planReviewer: 'claude-plan-reviewer',
      developer: 'codex-developer',
      finalReviewer: 'claude-final-reviewer',
    });
    expect(config.workflowRoles.high).toEqual({
      architect: 'claude-architect',
      planReviewer: 'codex-plan-reviewer',
      developer: 'codex-developer',
      finalReviewer: 'claude-final-reviewer',
    });
    expect(config.profiles[config.workflowRoles.high.architect]?.kind).toBe('claude');
    expect(config.profiles[config.workflowRoles.high.planReviewer]?.kind).toBe('codex');
  });

  it('lets each difficulty role point at a different profile', () => {
    const config = normalizeConfig({
      workflowRoles: {
        medium: {
          developer: 'custom-medium-developer',
        },
      },
      profiles: {
        'custom-medium-developer': {
          kind: 'codex',
          command: 'custom-codex',
        },
      },
    });

    expect(config.workflowRoles.medium.developer).toBe('custom-medium-developer');
    expect(config.workflowRoles.medium.architect).toBe('codex-architect');
    expect(config.profiles['custom-medium-developer']?.command).toBe('custom-codex');
  });
});
