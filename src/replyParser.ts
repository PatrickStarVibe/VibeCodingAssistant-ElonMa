import type { WorkflowDifficulty } from './types.js';

export type ParsedReply =
  | { kind: 'approve'; source: 'deterministic' }
  | { kind: 'reject'; source: 'deterministic' }
  | { kind: 'revise'; instruction: string; source: 'deterministic' }
  | { kind: 'difficulty'; level: WorkflowDifficulty; source: 'deterministic' }
  | { kind: 'stop'; source: 'deterministic' }
  | { kind: 'status'; source: 'deterministic' }
  | { kind: 'summary'; source: 'deterministic' }
  | { kind: 'accept'; source: 'deterministic' }
  | { kind: 'note'; note: string; source: 'deterministic' }
  | { kind: 'ambiguous'; reason: string; useLlmFallback: boolean };

function normalize(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

function isExact(value: string, matches: string[]): boolean {
  return matches.some((match) => value.toLocaleLowerCase() === match.toLocaleLowerCase());
}

export function parseDeterministicReply(input: string): ParsedReply {
  const text = normalize(input);
  const lower = text.toLocaleLowerCase();

  if (!text) {
    return { kind: 'ambiguous', reason: 'Empty reply.', useLlmFallback: false };
  }

  if (isExact(text, ['status'])) return { kind: 'status', source: 'deterministic' };
  if (isExact(text, ['summary'])) return { kind: 'summary', source: 'deterministic' };
  if (isExact(text, ['stop'])) return { kind: 'stop', source: 'deterministic' };
  if (isExact(text, ['accept', 'accepted'])) return { kind: 'accept', source: 'deterministic' };
  if (isExact(text, ['low', 'L', '低', '简单'])) return { kind: 'difficulty', level: 'low', source: 'deterministic' };
  if (isExact(text, ['medium', 'M', '中', '中等'])) return { kind: 'difficulty', level: 'medium', source: 'deterministic' };
  if (isExact(text, ['high', 'H', '高', '复杂', '困难'])) return { kind: 'difficulty', level: 'high', source: 'deterministic' };
  if (isExact(text, ['approve A', 'approve', 'A', 'yes', 'y', '同意', '批准'])) {
    return { kind: 'approve', source: 'deterministic' };
  }
  if (isExact(text, ['reject B', 'reject', 'B', 'no', 'n', '拒绝', '不同意'])) {
    return { kind: 'reject', source: 'deterministic' };
  }

  const noteMatch = text.match(/^note\s*:\s*(.+)$/i);
  if (noteMatch?.[1]?.trim()) {
    return { kind: 'note', note: noteMatch[1].trim(), source: 'deterministic' };
  }

  const reviseMatch = text.match(/^(?:revise\s+c|revise|c)\s*:\s*(.+)$/i);
  if (reviseMatch?.[1]?.trim()) {
    return { kind: 'revise', instruction: reviseMatch[1].trim(), source: 'deterministic' };
  }

  if (/^(?:revise\s+c|revise|c)$/i.test(text)) {
    return {
      kind: 'ambiguous',
      reason: 'Revision replies must include instructions after a colon, for example: revise C: keep the MVP smaller.',
      useLlmFallback: false,
    };
  }

  if ((lower.includes('approve') || lower.includes('同意') || /\ba\b/i.test(text)) && (lower.includes('改') || lower.includes('change') || lower.includes('but'))) {
    return {
      kind: 'ambiguous',
      reason: 'The reply mixes approval with requested changes.',
      useLlmFallback: false,
    };
  }

  return { kind: 'ambiguous', reason: 'Reply did not match the deterministic whitelist.', useLlmFallback: true };
}
