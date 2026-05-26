import { describe, expect, it } from 'vitest';

import {
  activeBlockers,
  applyArchitectResponses,
  applyReviewerOutput,
  parseArchitectResponsesBlock,
  parseReviewerBlockerBlock,
  renderBlockerLedgerArtifact,
  renderLedgerForArchitectPrompt,
  renderLedgerForReviewerPrompt,
  renderRoundLedgerSnapshot,
  renderUnclosedBlockerSummary,
  validateArchitectResponsesAgainstLedger,
  validateReviewerOutputAgainstLedger,
} from '../src/blockerLedger.js';
import type { ArchitectBlockerResponse, BlockerLedger, ReviewerBlockerOutput } from '../src/types.js';

function introduced(id = 'B1'): ReviewerBlockerOutput {
  return {
    blockers: [{
      id,
      severity: 'blocker',
      category: 'test',
      title: 'Verification missing',
      detail: 'The plan does not define verification.',
      verifyHint: 'Add concrete verification commands.',
    }],
    previousVerdicts: [],
  };
}

function response(id = 'B1', overrides: Partial<ArchitectBlockerResponse> = {}): ArchitectBlockerResponse {
  return {
    id,
    status: 'addressed',
    summary: 'Added verification commands.',
    planAnchor: '## Verification Commands',
    ...overrides,
  };
}

function ledgerWithB1(): BlockerLedger {
  return applyReviewerOutput(undefined, introduced(), 1);
}

describe('blocker ledger parser', () => {
  it('parses and strips reviewer blocker blocks', () => {
    const parsed = parseReviewerBlockerBlock([
      '# Review',
      '',
      '```reviewer-blockers',
      JSON.stringify(introduced(), null, 2),
      '```',
      '',
      'More review.',
    ].join('\n'));

    expect(parsed?.ok).toBe(true);
    if (!parsed?.ok) return;
    expect(parsed.output.blockers[0]?.id).toBe('B1');
    expect(parsed.strippedMarkdown).toContain('# Review');
    expect(parsed.strippedMarkdown).not.toContain('reviewer-blockers');
  });

  it('rejects invalid reviewer blocks and ignores missing blocks', () => {
    expect(parseReviewerBlockerBlock('# Review only')).toBeUndefined();
    expect(parseReviewerBlockerBlock('```reviewer-blockers\n{ nope\n```')?.ok).toBe(false);
    expect(parseReviewerBlockerBlock([
      '```reviewer-blockers',
      '{ "blockers": [], "previousBlockerVerdicts": [] }',
      '```',
      '```reviewer-blockers',
      '{ "blockers": [], "previousBlockerVerdicts": [] }',
      '```',
    ].join('\n'))?.ok).toBe(false);
    expect(parseReviewerBlockerBlock('```reviewer-blockers\n{ "blockers": [] }\n```')?.ok).toBe(false);
  });

  it('parses architect response blocks', () => {
    const parsed = parseArchitectResponsesBlock([
      '# Revised Plan',
      '',
      '```architect-blocker-responses',
      JSON.stringify({ responses: [response()] }, null, 2),
      '```',
    ].join('\n'));

    expect(parsed?.ok).toBe(true);
    if (!parsed?.ok) return;
    expect(parsed.responses[0]?.planAnchor).toBe('## Verification Commands');
    expect(parsed.strippedMarkdown).not.toContain('architect-blocker-responses');
    expect(parseArchitectResponsesBlock('# Plan only')).toBeUndefined();
    expect(parseArchitectResponsesBlock('```architect-blocker-responses\n{ nope\n```')?.ok).toBe(false);
  });
});

describe('blocker ledger validation and application', () => {
  it('requires first reviewer round verdicts to be empty and later rounds to cover active blockers', () => {
    expect(validateReviewerOutputAgainstLedger({
      blockers: [],
      previousVerdicts: [{ id: 'B1', verdict: 'closed', reason: 'done' }],
    }, undefined, 1)).toMatchObject({ ok: false });

    const ledger = ledgerWithB1();
    expect(validateReviewerOutputAgainstLedger({
      blockers: [],
      previousVerdicts: [],
    }, ledger, 2)).toMatchObject({ ok: false });
    expect(validateReviewerOutputAgainstLedger({
      blockers: [],
      previousVerdicts: [{ id: 'B1', verdict: 'still_open', reason: 'still missing tests' }],
    }, ledger, 2)).toEqual({ ok: true });
  });

  it('allows non-contiguous new ids only when they are greater than the existing max', () => {
    const ledger = ledgerWithB1();
    expect(validateReviewerOutputAgainstLedger({
      blockers: [{
        ...introduced('B3').blockers[0]!,
        id: 'B3',
      }],
      previousVerdicts: [{ id: 'B1', verdict: 'closed', reason: 'fixed' }],
    }, ledger, 2)).toEqual({ ok: true });
    expect(validateReviewerOutputAgainstLedger({
      blockers: [{
        ...introduced('B1').blockers[0]!,
        id: 'B1',
      }],
      previousVerdicts: [{ id: 'B1', verdict: 'closed', reason: 'fixed' }],
    }, ledger, 2)).toMatchObject({ ok: false });
  });

  it('requires changed blockers to be restated and architect responses to cover active ids', () => {
    const ledger = ledgerWithB1();
    expect(validateReviewerOutputAgainstLedger({
      blockers: [],
      previousVerdicts: [{ id: 'B1', verdict: 'changed', reason: 'scope changed' }],
    }, ledger, 2)).toMatchObject({ ok: false });
    expect(validateArchitectResponsesAgainstLedger([], ledger)).toMatchObject({ ok: false });
    expect(validateArchitectResponsesAgainstLedger([response('B2')], ledger)).toMatchObject({ ok: false });
    expect(validateArchitectResponsesAgainstLedger([response('B1', { planAnchor: undefined })], ledger)).toMatchObject({ ok: false });
    expect(validateArchitectResponsesAgainstLedger([response()], ledger)).toEqual({ ok: true });
  });

  it('records architect responses and reviewer closure history', () => {
    const ledger = ledgerWithB1();
    const architectApplied = applyArchitectResponses(ledger, [response('B1', {
      status: 'rejected',
      summary: 'Rejected summary.',
      rejectionReason: 'This is outside scope.',
      planAnchor: undefined,
    })], 2);
    expect(architectApplied.blockers[0]?.status).toBe('rejected_by_architect_pending_reviewer');
    expect(architectApplied.blockers[0]?.history.at(-1)?.kind).toBe('architect_rejected');

    const closed = applyReviewerOutput(architectApplied, {
      blockers: [],
      previousVerdicts: [{ id: 'B1', verdict: 'closed', reason: 'Reviewer accepts the rejection.' }],
    }, 3);
    expect(activeBlockers(closed)).toHaveLength(0);
    expect(closed.blockers[0]?.history.map((entry) => entry.kind)).toEqual([
      'introduced',
      'architect_rejected',
      'closed',
    ]);
  });

  it('renders prompt and artifact summaries with blocker identity', () => {
    const ledger = applyArchitectResponses(ledgerWithB1(), [response()], 2);

    expect(renderLedgerForArchitectPrompt(ledger)).toContain('B1 [blocker/test/open] Verification missing');
    expect(renderLedgerForReviewerPrompt(ledger)).toContain('latest architect/reviewer history');
    expect(renderRoundLedgerSnapshot(ledger, 2)).toContain('Active blockers: 1');
    expect(renderUnclosedBlockerSummary(ledger)).toContain('B1 (blocker, test): Verification missing');
    expect(renderBlockerLedgerArtifact(ledger)).toContain('architect_addressed');
  });
});
