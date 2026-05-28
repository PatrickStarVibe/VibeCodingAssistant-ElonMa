import { describe, expect, it } from 'vitest';

import { parseUserDecisionBlock } from '../src/userDecision.js';

const validDecisionBlock = [
  '```assistant-user-decision',
  '{',
  '  "question": "Which scope should ship first?",',
  '  "rationale": "The choice changes verification and implementation scope.",',
  '  "options": [',
  '    { "label": "Ship MVP", "impact": "Keeps the first pass focused." },',
  '    { "label": "Ship full scope", "impact": "Covers more but takes longer." }',
  '  ],',
  '  "recommendedOptionId": "A",',
  '  "recommendationReason": "MVP matches the requested task boundary."',
  '}',
  '```',
].join('\n');

describe('parseUserDecisionBlock', () => {
  it('parses a valid decision block and strips it from markdown', () => {
    const parsed = parseUserDecisionBlock([
      '# Plan',
      '',
      validDecisionBlock,
      '',
      '## Notes',
      'Keep the rest of the plan.',
    ].join('\n'), 'architect_plan');

    expect(parsed?.ok).toBe(true);
    if (!parsed?.ok) return;
    expect(parsed.result.decision.source).toBe('architect_plan');
    expect(parsed.result.decision.options.map((option) => option.id)).toEqual(['A', 'B']);
    expect(parsed.result.decision.recommendedOptionId).toBe('A');
    expect(parsed.result.strippedMarkdown).toContain('# Plan');
    expect(parsed.result.strippedMarkdown).toContain('## Notes');
    expect(parsed.result.strippedMarkdown).not.toContain('assistant-user-decision');
  });

  it('returns undefined for ordinary markdown', () => {
    expect(parseUserDecisionBlock('# Plan\n\nNo blockers.', 'architect_plan')).toBeUndefined();
  });

  it('rejects multiple decision blocks', () => {
    const parsed = parseUserDecisionBlock([validDecisionBlock, '', validDecisionBlock].join('\n'), 'architect_plan');

    expect(parsed?.ok).toBe(false);
    if (parsed?.ok || !parsed) return;
    expect(parsed.error).toContain('multiple assistant-user-decision blocks');
  });

  it('rejects invalid JSON and invalid option payloads', () => {
    const invalidJson = parseUserDecisionBlock('```assistant-user-decision\n{ nope\n```', 'architect_plan');
    expect(invalidJson?.ok).toBe(false);

    const invalidPayload = parseUserDecisionBlock([
      '```assistant-user-decision',
      '{ "question": "Pick one", "rationale": "Scope changes", "options": [] }',
      '```',
    ].join('\n'), 'plan_review');
    expect(invalidPayload?.ok).toBe(false);
    if (invalidPayload?.ok || !invalidPayload) return;
    expect(invalidPayload.error).toContain('options must contain 1 to 4 options');
  });

  it('rejects explicit user-decision markers without a block but ignores negated lines', () => {
    const invalid = parseUserDecisionBlock('NEEDS_USER_DECISION: pick a direction.', 'architect_plan');
    expect(invalid?.ok).toBe(false);

    expect(parseUserDecisionBlock('This does not require a user decision.', 'architect_plan')).toBeUndefined();
    expect(parseUserDecisionBlock('No user decision is needed.', 'plan_review')).toBeUndefined();
    expect(parseUserDecisionBlock('非阻塞但建议处理；没有需要用户决策的产品/范围问题。', 'plan_review')).toBeUndefined();
  });
});
