import type {
  ArchitectBlockerResponse,
  BlockerCategory,
  BlockerLedger,
  BlockerSeverity,
  ReviewerBlocker,
  ReviewerBlockerDraft,
  ReviewerBlockerOutput,
  ReviewerBlockerVerdict,
  ReviewerPreviousBlockerVerdict,
} from './types.js';

const REVIEWER_BLOCKER_BLOCK_PATTERN = /^```reviewer-blockers[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const ARCHITECT_RESPONSE_BLOCK_PATTERN = /^```architect-blocker-responses[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const BLOCKER_ID_PATTERN = /^B([1-9]\d*)$/;
const SEVERITIES = new Set<BlockerSeverity>(['blocker', 'high', 'medium']);
const CATEGORIES = new Set<BlockerCategory>(['design', 'test', 'scope', 'risk', 'ambiguity', 'other']);
const REVIEWER_VERDICTS = new Set<ReviewerBlockerVerdict>(['closed', 'still_open', 'changed']);
const ARCHITECT_STATUSES = new Set<ArchitectBlockerResponse['status']>([
  'addressed',
  'partially_addressed',
  'needs_user_decision',
  'rejected',
]);

export type ReviewerBlockerBlockParseResult =
  | { ok: true; output: ReviewerBlockerOutput; strippedMarkdown: string }
  | { ok: false; error: string; strippedMarkdown: string };

export type ArchitectResponsesBlockParseResult =
  | { ok: true; responses: ArchitectBlockerResponse[]; strippedMarkdown: string }
  | { ok: false; error: string; strippedMarkdown: string };

export function parseReviewerBlockerBlock(markdown: string): ReviewerBlockerBlockParseResult | undefined {
  const matches = [...markdown.matchAll(REVIEWER_BLOCKER_BLOCK_PATTERN)];
  if (matches.length === 0) return undefined;

  const strippedMarkdown = stripBlocks(markdown, REVIEWER_BLOCKER_BLOCK_PATTERN);
  if (matches.length > 1) return { ok: false, error: 'multiple reviewer-blockers blocks', strippedMarkdown };

  const parsed = parseJson(matches[0]?.[1] ?? '', 'reviewer-blockers');
  if (!parsed.ok) return { ok: false, error: parsed.error, strippedMarkdown };

  const normalized = normalizeReviewerBlockerOutput(parsed.value);
  if (!normalized.ok) return { ok: false, error: normalized.error, strippedMarkdown };
  return { ok: true, output: normalized.output, strippedMarkdown };
}

export function parseArchitectResponsesBlock(markdown: string): ArchitectResponsesBlockParseResult | undefined {
  const matches = [...markdown.matchAll(ARCHITECT_RESPONSE_BLOCK_PATTERN)];
  if (matches.length === 0) return undefined;

  const strippedMarkdown = stripBlocks(markdown, ARCHITECT_RESPONSE_BLOCK_PATTERN);
  if (matches.length > 1) return { ok: false, error: 'multiple architect-blocker-responses blocks', strippedMarkdown };

  const parsed = parseJson(matches[0]?.[1] ?? '', 'architect-blocker-responses');
  if (!parsed.ok) return { ok: false, error: parsed.error, strippedMarkdown };

  const normalized = normalizeArchitectResponses(parsed.value);
  if (!normalized.ok) return { ok: false, error: normalized.error, strippedMarkdown };
  return { ok: true, responses: normalized.responses, strippedMarkdown };
}

export function validateReviewerOutputAgainstLedger(
  output: ReviewerBlockerOutput,
  ledger: BlockerLedger | undefined,
  round: number,
): { ok: true } | { ok: false; error: string } {
  const active = ledger ? activeBlockers(ledger) : [];
  const activeIds = new Set(active.map((blocker) => blocker.id));
  const existingIds = new Set((ledger?.blockers ?? []).map((blocker) => blocker.id));
  const verdictIds = new Set<string>();
  const blockerIds = new Set<string>();
  const maxExisting = maxBlockerNumber(ledger);

  for (const verdict of output.previousVerdicts) {
    if (verdictIds.has(verdict.id)) return { ok: false, error: `duplicate previousBlockerVerdicts id ${verdict.id}` };
    verdictIds.add(verdict.id);
    if (!activeIds.has(verdict.id)) return { ok: false, error: `previousBlockerVerdicts contains unknown or closed id ${verdict.id}` };
  }

  if (round <= 1 || active.length === 0 && !ledger) {
    if (output.previousVerdicts.length > 0) {
      return { ok: false, error: 'first reviewer ledger round must use previousBlockerVerdicts: []' };
    }
  } else {
    const missing = active.map((blocker) => blocker.id).filter((id) => !verdictIds.has(id));
    if (missing.length > 0) return { ok: false, error: `missing previousBlockerVerdicts for active blocker id(s): ${missing.join(', ')}` };
  }

  for (const blocker of output.blockers) {
    if (blockerIds.has(blocker.id)) return { ok: false, error: `duplicate blocker id ${blocker.id}` };
    blockerIds.add(blocker.id);
    const numeric = blockerNumber(blocker.id);
    if (numeric === undefined) return { ok: false, error: `invalid blocker id ${blocker.id}` };

    if (!existingIds.has(blocker.id)) {
      if (numeric <= maxExisting) {
        return { ok: false, error: `new blocker id ${blocker.id} must be greater than existing max B${maxExisting}` };
      }
      continue;
    }

    const verdict = output.previousVerdicts.find((item) => item.id === blocker.id);
    if (!verdict || verdict.verdict !== 'changed') {
      return { ok: false, error: `existing blocker ${blocker.id} can only appear in blockers when its verdict is changed` };
    }
  }

  for (const verdict of output.previousVerdicts) {
    if (verdict.verdict === 'changed' && !blockerIds.has(verdict.id)) {
      return { ok: false, error: `changed blocker ${verdict.id} must also appear in blockers with updated detail` };
    }
    if (verdict.verdict !== 'changed' && blockerIds.has(verdict.id)) {
      return { ok: false, error: `${verdict.verdict} blocker ${verdict.id} must not be repeated in blockers` };
    }
  }

  return { ok: true };
}

export function validateArchitectResponsesAgainstLedger(
  responses: ArchitectBlockerResponse[],
  ledger: BlockerLedger,
): { ok: true } | { ok: false; error: string } {
  const active = activeBlockers(ledger);
  const activeIds = new Set(active.map((blocker) => blocker.id));
  const responseIds = new Set<string>();

  for (const response of responses) {
    if (responseIds.has(response.id)) return { ok: false, error: `duplicate architect response id ${response.id}` };
    responseIds.add(response.id);
    if (!activeIds.has(response.id)) return { ok: false, error: `architect response references unknown or closed blocker id ${response.id}` };
    if ((response.status === 'addressed' || response.status === 'partially_addressed') && !response.planAnchor?.trim()) {
      return { ok: false, error: `architect response ${response.id} requires planAnchor` };
    }
    if (response.status === 'rejected' && !response.rejectionReason?.trim()) {
      return { ok: false, error: `architect response ${response.id} requires rejectionReason when rejected` };
    }
  }

  const missing = active.map((blocker) => blocker.id).filter((id) => !responseIds.has(id));
  if (missing.length > 0) return { ok: false, error: `missing architect response for active blocker id(s): ${missing.join(', ')}` };
  return { ok: true };
}

export function applyArchitectResponses(
  ledger: BlockerLedger,
  responses: ArchitectBlockerResponse[],
  round: number,
): BlockerLedger {
  const byId = new Map(responses.map((response) => [response.id, response]));
  return {
    rounds: Math.max(ledger.rounds, round),
    blockers: ledger.blockers.map((blocker) => {
      const response = byId.get(blocker.id);
      if (!response || blocker.status === 'closed') return cloneBlocker(blocker);
      const kind = response.status === 'addressed'
        ? 'architect_addressed'
        : response.status === 'partially_addressed'
          ? 'architect_partial'
          : response.status === 'needs_user_decision'
            ? 'architect_needs_user_decision'
            : 'architect_rejected';
      return {
        ...cloneBlocker(blocker),
        status: response.status === 'rejected' ? 'rejected_by_architect_pending_reviewer' : 'open',
        lastUpdatedRound: round,
        history: [
          ...blocker.history,
          {
            round,
            kind,
            note: response.status === 'rejected'
              ? (response.rejectionReason ?? response.summary)
              : response.summary,
            ...(response.planAnchor ? { planAnchor: response.planAnchor } : {}),
          },
        ],
      };
    }),
  };
}

export function applyReviewerOutput(
  ledger: BlockerLedger | undefined,
  output: ReviewerBlockerOutput,
  round: number,
): BlockerLedger {
  const current: BlockerLedger = ledger
    ? { rounds: Math.max(ledger.rounds, round), blockers: ledger.blockers.map(cloneBlocker) }
    : { rounds: round, blockers: [] };
  const byId = new Map(current.blockers.map((blocker) => [blocker.id, blocker]));
  const draftById = new Map(output.blockers.map((blocker) => [blocker.id, blocker]));

  for (const verdict of output.previousVerdicts) {
    const blocker = byId.get(verdict.id);
    if (!blocker) continue;
    if (verdict.verdict === 'closed') {
      blocker.status = 'closed';
      blocker.lastUpdatedRound = round;
      blocker.history.push({ round, kind: 'closed', note: verdict.reason });
    } else if (verdict.verdict === 'still_open') {
      blocker.status = 'open';
      blocker.lastUpdatedRound = round;
      blocker.history.push({ round, kind: 'still_open', note: verdict.reason });
    } else {
      const draft = draftById.get(verdict.id);
      if (!draft) continue;
      updateBlockerFromDraft(blocker, draft, round);
      blocker.history.push({ round, kind: 'changed', note: verdict.reason });
    }
  }

  for (const draft of output.blockers) {
    if (byId.has(draft.id)) continue;
    current.blockers.push({
      ...draft,
      firstSeenRound: round,
      lastUpdatedRound: round,
      status: 'open',
      history: [{ round, kind: 'introduced', note: draft.detail }],
    });
  }

  current.blockers.sort((left, right) => (blockerNumber(left.id) ?? 0) - (blockerNumber(right.id) ?? 0));
  return current;
}

export function activeBlockers(ledger: BlockerLedger): ReviewerBlocker[] {
  return ledger.blockers.filter((blocker) => blocker.status !== 'closed');
}

export function renderLedgerForArchitectPrompt(ledger: BlockerLedger): string {
  const active = activeBlockers(ledger);
  if (active.length === 0) return '(no active blockers)';
  return active.map((blocker) => [
    `- ${blocker.id} [${blocker.severity}/${blocker.category}/${blocker.status}] ${blocker.title}`,
    `  detail: ${blocker.detail}`,
    `  verifyHint: ${blocker.verifyHint}`,
    lastHistoryLine(blocker) ? `  latest: ${lastHistoryLine(blocker)}` : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n')).join('\n');
}

export function renderLedgerForReviewerPrompt(ledger: BlockerLedger): string {
  const active = activeBlockers(ledger);
  if (active.length === 0) return '(no active blockers)';
  return active.map((blocker) => [
    `- ${blocker.id} [${blocker.severity}/${blocker.category}/${blocker.status}] ${blocker.title}`,
    `  detail: ${blocker.detail}`,
    `  verifyHint: ${blocker.verifyHint}`,
    lastHistoryLine(blocker) ? `  latest architect/reviewer history: ${lastHistoryLine(blocker)}` : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n')).join('\n');
}

export function renderRoundLedgerSnapshot(ledger: BlockerLedger, round: number): string {
  const active = activeBlockers(ledger);
  const closed = ledger.blockers.filter((blocker) => blocker.status === 'closed');
  return [
    `Round: ${round}`,
    `Active blockers: ${active.length}`,
    `Closed blockers: ${closed.length}`,
    '',
    ...ledger.blockers.map((blocker) => (
      `- ${blocker.id} [${blocker.status}; ${blocker.severity}/${blocker.category}; first ${blocker.firstSeenRound}, updated ${blocker.lastUpdatedRound}] ${blocker.title}`
    )),
  ].join('\n').trim();
}

export function renderUnclosedBlockerSummary(ledger: BlockerLedger): string {
  const active = activeBlockers(ledger);
  if (active.length === 0) return 'No active blockers remain.';
  return active.map((blocker) => (
    `${blocker.id} (${blocker.severity}, ${blocker.category}): ${blocker.title}`
  )).join('\n');
}

export function renderBlockerLedgerArtifact(ledger: BlockerLedger): string {
  const active = activeBlockers(ledger);
  return [
    '# Blocker Ledger',
    '',
    `Reviewer rounds: ${ledger.rounds}`,
    `Active blockers: ${active.length}`,
    '',
    ...ledger.blockers.map((blocker) => [
      `## ${blocker.id}: ${blocker.title}`,
      '',
      `- Status: ${blocker.status}`,
      `- Severity: ${blocker.severity}`,
      `- Category: ${blocker.category}`,
      `- First seen round: ${blocker.firstSeenRound}`,
      `- Last updated round: ${blocker.lastUpdatedRound}`,
      `- Detail: ${blocker.detail}`,
      `- Verify hint: ${blocker.verifyHint}`,
      '',
      'History:',
      ...blocker.history.map((entry) => (
        `- Round ${entry.round}: ${entry.kind} - ${entry.note}${entry.planAnchor ? ` (anchor: ${entry.planAnchor})` : ''}`
      )),
      '',
    ].join('\n')),
  ].join('\n').trim();
}

function normalizeReviewerBlockerOutput(value: unknown): { ok: true; output: ReviewerBlockerOutput } | { ok: false; error: string } {
  const payload = record(value);
  const rawBlockers = Array.isArray(payload.blockers) ? payload.blockers : undefined;
  if (!rawBlockers) return { ok: false, error: 'reviewer-blockers.blockers must be an array' };
  const rawVerdicts = Array.isArray(payload.previousBlockerVerdicts)
    ? payload.previousBlockerVerdicts
    : Array.isArray(payload.previousVerdicts)
      ? payload.previousVerdicts
      : undefined;
  if (!rawVerdicts) return { ok: false, error: 'reviewer-blockers.previousBlockerVerdicts must be an array' };

  const blockers: ReviewerBlockerDraft[] = [];
  for (let index = 0; index < rawBlockers.length; index += 1) {
    const item = record(rawBlockers[index]);
    const id = requiredString(item.id, `blockers[${index}].id`);
    if (!id.ok) return id;
    if (!BLOCKER_ID_PATTERN.test(id.value)) return { ok: false, error: `blockers[${index}].id must look like B1` };
    const severity = requiredEnum(item.severity, SEVERITIES, `blockers[${index}].severity`);
    if (!severity.ok) return severity;
    const category = requiredEnum(item.category, CATEGORIES, `blockers[${index}].category`);
    if (!category.ok) return category;
    const title = requiredString(item.title, `blockers[${index}].title`);
    if (!title.ok) return title;
    const detail = requiredString(item.detail, `blockers[${index}].detail`);
    if (!detail.ok) return detail;
    const verifyHint = requiredString(item.verifyHint, `blockers[${index}].verifyHint`);
    if (!verifyHint.ok) return verifyHint;
    blockers.push({ id: id.value, severity: severity.value, category: category.value, title: title.value, detail: detail.value, verifyHint: verifyHint.value });
  }

  const previousVerdicts: ReviewerPreviousBlockerVerdict[] = [];
  for (let index = 0; index < rawVerdicts.length; index += 1) {
    const item = record(rawVerdicts[index]);
    const id = requiredString(item.id, `previousBlockerVerdicts[${index}].id`);
    if (!id.ok) return id;
    if (!BLOCKER_ID_PATTERN.test(id.value)) return { ok: false, error: `previousBlockerVerdicts[${index}].id must look like B1` };
    const verdict = requiredEnum(item.verdict, REVIEWER_VERDICTS, `previousBlockerVerdicts[${index}].verdict`);
    if (!verdict.ok) return verdict;
    const reason = requiredString(item.reason, `previousBlockerVerdicts[${index}].reason`);
    if (!reason.ok) return reason;
    previousVerdicts.push({ id: id.value, verdict: verdict.value, reason: reason.value });
  }

  return { ok: true, output: { blockers, previousVerdicts } };
}

function normalizeArchitectResponses(value: unknown): { ok: true; responses: ArchitectBlockerResponse[] } | { ok: false; error: string } {
  const payload = record(value);
  const rawResponses = Array.isArray(payload.responses) ? payload.responses : undefined;
  if (!rawResponses) return { ok: false, error: 'architect-blocker-responses.responses must be an array' };

  const responses: ArchitectBlockerResponse[] = [];
  for (let index = 0; index < rawResponses.length; index += 1) {
    const item = record(rawResponses[index]);
    const id = requiredString(item.id, `responses[${index}].id`);
    if (!id.ok) return id;
    if (!BLOCKER_ID_PATTERN.test(id.value)) return { ok: false, error: `responses[${index}].id must look like B1` };
    const status = requiredEnum(item.status, ARCHITECT_STATUSES, `responses[${index}].status`);
    if (!status.ok) return status;
    const summary = requiredString(item.summary, `responses[${index}].summary`);
    if (!summary.ok) return summary;
    const planAnchor = optionalString(item.planAnchor);
    const rejectionReason = optionalString(item.rejectionReason);
    responses.push({
      id: id.value,
      status: status.value,
      summary: summary.value,
      ...(planAnchor ? { planAnchor } : {}),
      ...(rejectionReason ? { rejectionReason } : {}),
    });
  }

  return { ok: true, responses };
}

function parseJson(rawJson: string, label: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(rawJson) };
  } catch (error) {
    return { ok: false, error: `${label} block must contain valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function stripBlocks(markdown: string, pattern: RegExp): string {
  return markdown.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  const next = optionalString(value);
  return next ? { ok: true, value: next } : { ok: false, error: `${field} is required` };
}

function requiredEnum<T extends string>(
  value: unknown,
  allowed: Set<T>,
  field: string,
): { ok: true; value: T } | { ok: false; error: string } {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    return { ok: false, error: `${field} must be one of: ${[...allowed].join(', ')}` };
  }
  return { ok: true, value: value as T };
}

function blockerNumber(id: string): number | undefined {
  const match = id.match(BLOCKER_ID_PATTERN);
  if (!match?.[1]) return undefined;
  return Number.parseInt(match[1], 10);
}

function maxBlockerNumber(ledger: BlockerLedger | undefined): number {
  return Math.max(0, ...(ledger?.blockers ?? []).map((blocker) => blockerNumber(blocker.id) ?? 0));
}

function cloneBlocker(blocker: ReviewerBlocker): ReviewerBlocker {
  return {
    ...blocker,
    history: blocker.history.map((entry) => ({ ...entry })),
  };
}

function updateBlockerFromDraft(blocker: ReviewerBlocker, draft: ReviewerBlockerDraft, round: number): void {
  blocker.severity = draft.severity;
  blocker.category = draft.category;
  blocker.title = draft.title;
  blocker.detail = draft.detail;
  blocker.verifyHint = draft.verifyHint;
  blocker.status = 'open';
  blocker.lastUpdatedRound = round;
}

function lastHistoryLine(blocker: ReviewerBlocker): string | undefined {
  const latest = blocker.history[blocker.history.length - 1];
  if (!latest) return undefined;
  return `round ${latest.round} ${latest.kind}: ${latest.note}${latest.planAnchor ? ` (anchor: ${latest.planAnchor})` : ''}`;
}
