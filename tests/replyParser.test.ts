import { describe, expect, it } from 'vitest';

import { parseDeterministicReply } from '../src/replyParser.js';

describe('parseDeterministicReply', () => {
  it.each([
    ['approve A', 'approve'],
    ['A', 'approve'],
    ['yes', 'approve'],
    ['同意', 'approve'],
    ['reject B', 'reject'],
    ['B', 'reject'],
    ['stop', 'stop'],
    ['status', 'status'],
    ['summary', 'summary'],
  ])('matches %s as %s through the deterministic whitelist', (reply, kind) => {
    expect(parseDeterministicReply(reply)).toMatchObject({ kind });
  });

  it.each([
    ['low', 'low'],
    ['M', 'medium'],
    ['高', 'high'],
    ['复杂', 'high'],
    ['  mEdIuM  ', 'medium'],
  ])('matches %s as difficulty %s through the deterministic whitelist', (reply, level) => {
    expect(parseDeterministicReply(reply)).toEqual({
      kind: 'difficulty',
      level,
      source: 'deterministic',
    });
  });

  it('parses revise C only when instructions are present after a colon', () => {
    expect(parseDeterministicReply('revise C: reduce scope')).toEqual({
      kind: 'revise',
      instruction: 'reduce scope',
      source: 'deterministic',
    });
  });

  it.each([
    ['approve A 但要小改一下', false, 'mixes approval'],
    ['好的', true, 'whitelist'],
    ['mediumish', true, 'whitelist'],
    ['approve A low', true, 'whitelist'],
    ['   ', false, 'Empty reply'],
    ['revise', false, 'Revision replies must include instructions'],
    ['revise C', false, 'Revision replies must include instructions'],
  ])('handles ambiguous reply %s', (reply, useLlmFallback, reasonSnippet) => {
    const parsed = parseDeterministicReply(reply);
    expect(parsed.kind).toBe('ambiguous');
    if (parsed.kind === 'ambiguous') {
      expect(parsed.useLlmFallback).toBe(useLlmFallback);
      expect(parsed.reason).toContain(reasonSnippet);
    }
  });
});
