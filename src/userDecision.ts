import type {
  PendingUserDecision,
  PendingUserDecisionOption,
  PendingUserDecisionSource,
  UserDecisionOptionId,
} from './types.js';

const OPTION_IDS = ['A', 'B', 'C', 'D'] as const;

export type PendingUserDecisionValidation =
  | { ok: true; decision: PendingUserDecision }
  | { ok: false; error: string };

export interface ParsedDecisionBlock {
  decision: PendingUserDecision;
  strippedMarkdown: string;
}

export type UserDecisionBlockParseResult =
  | { ok: true; result: ParsedDecisionBlock }
  | { ok: false; error: string; strippedMarkdown: string };

const DECISION_BLOCK_PATTERN = /^```assistant-user-decision[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

export function normalizePendingUserDecision(value: unknown, source: PendingUserDecisionSource): PendingUserDecisionValidation {
  const payload = record(value);
  if (Object.keys(payload).length === 0) return { ok: false, error: 'missing userDecision object' };

  const question = stringValue(payload.question);
  if (!question) return { ok: false, error: 'userDecision.question is required' };

  const rationale = stringValue(payload.rationale) ?? stringValue(payload.reason) ?? stringValue(payload.why);
  if (!rationale) return { ok: false, error: 'userDecision.rationale is required' };

  const rawOptions = Array.isArray(payload.options) ? payload.options : [];
  if (rawOptions.length === 0) return { ok: false, error: 'userDecision.options must contain 1 to 4 options' };
  if (rawOptions.length > OPTION_IDS.length) return { ok: false, error: 'userDecision.options must not contain more than 4 options' };

  const options: PendingUserDecisionOption[] = [];
  for (let index = 0; index < rawOptions.length; index += 1) {
    const expectedId = OPTION_IDS[index];
    if (!expectedId) return { ok: false, error: 'userDecision.options must not contain more than 4 options' };
    const option = record(rawOptions[index]);
    const providedId = optionIdValue(option.id ?? option.optionId ?? option.key);
    if (providedId && providedId !== expectedId) {
      return { ok: false, error: `userDecision.options[${index}].id must be ${expectedId}` };
    }
    const label = stringValue(option.label) ?? stringValue(option.title) ?? stringValue(option.text);
    if (!label) return { ok: false, error: `userDecision.options[${index}].label is required` };
    const impact = stringValue(option.impact) ?? stringValue(option.description) ?? stringValue(option.tradeoff);
    if (!impact) return { ok: false, error: `userDecision.options[${index}].impact is required` };
    options.push({ id: expectedId, label, impact });
  }

  const recommendedOptionId = optionIdValue(payload.recommendedOptionId ?? payload.recommendedOption ?? payload.recommendation);
  const recommendationReason = stringValue(payload.recommendationReason)
    ?? stringValue(payload.recommendedReason)
    ?? stringValue(payload.recommendationRationale);
  if (recommendedOptionId && !options.some((option) => option.id === recommendedOptionId)) {
    return { ok: false, error: 'userDecision.recommendedOptionId must match one of the options' };
  }
  if (recommendedOptionId && !recommendationReason) {
    return { ok: false, error: 'userDecision.recommendationReason is required when recommendedOptionId is set' };
  }

  return {
    ok: true,
    decision: {
      id: stringValue(payload.id) ?? `${source}:${slug(question)}`,
      source,
      question,
      rationale,
      options,
      ...(recommendedOptionId ? { recommendedOptionId } : {}),
      ...(recommendationReason ? { recommendationReason } : {}),
      allowFreeform: true,
    },
  };
}

export function parseUserDecisionBlock(
  markdown: string,
  source: PendingUserDecisionSource,
): UserDecisionBlockParseResult | undefined {
  const matches = [...markdown.matchAll(DECISION_BLOCK_PATTERN)];
  if (matches.length === 0) {
    return hasUnstructuredUserDecisionMarker(markdown)
      ? {
          ok: false,
          error: 'user decision marker present without assistant-user-decision block',
          strippedMarkdown: stripDecisionBlocks(markdown),
        }
      : undefined;
  }

  const strippedMarkdown = stripDecisionBlocks(markdown);
  if (matches.length > 1) {
    return { ok: false, error: 'multiple assistant-user-decision blocks', strippedMarkdown };
  }

  const rawJson = matches[0]?.[1] ?? '';
  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch (error) {
    return {
      ok: false,
      error: `assistant-user-decision block must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      strippedMarkdown,
    };
  }

  const normalized = normalizePendingUserDecision(payload, source);
  if (!normalized.ok) return { ok: false, error: normalized.error, strippedMarkdown };
  return { ok: true, result: { decision: normalized.decision, strippedMarkdown } };
}

export function renderPendingUserDecision(decision: PendingUserDecision): string {
  const recommended = decision.recommendedOptionId
    ? decision.options.find((option) => option.id === decision.recommendedOptionId)
    : undefined;
  return [
    '需要你做一个产品/范围/方向决定。',
    `来源：${sourceLabel(decision.source)}`,
    '',
    `问题：${decision.question}`,
    '',
    `为什么需要你确认：${decision.rationale}`,
    '',
    '选项：',
    ...decision.options.map((option) => `${option.id}. ${option.label}\n   影响：${option.impact}`),
    recommended ? '' : undefined,
    recommended ? `推荐：${recommended.id}. ${recommended.label}` : undefined,
    recommended && decision.recommendationReason ? `推荐理由：${decision.recommendationReason}` : undefined,
    '',
    '你可以直接回复 A/B/C/D，也可以自由描述你要的方向或修改意见。',
  ].filter((line): line is string => line !== undefined).join('\n');
}

export function renderInvalidUserDecisionPause(input: {
  source: PendingUserDecisionSource;
  error: string;
  fallbackText?: string;
}): string {
  const actor = decisionSourceActor(input.source);
  return [
    `${actor} output is invalid: it requested a user decision but did not provide a valid structured assistant-user-decision block.`,
    `来源：${sourceLabel(input.source)}`,
    `校验失败：${input.error}`,
    '',
    'workflow 已暂停，不会继续自动规划或实现。',
    'Please ask the source agent to provide an A/B/C/D structured assistant-user-decision block, or reply directly with the direction you want.',
    input.fallbackText ? '' : undefined,
    input.fallbackText ? '原始输出摘录：' : undefined,
    input.fallbackText ? shorten(input.fallbackText, 1000) : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');
}

export function selectedDecisionOption(
  decision: PendingUserDecision | undefined,
  answer: string,
): PendingUserDecisionOption | undefined {
  if (!decision) return undefined;
  const id = exactOptionIdFromAnswer(answer);
  if (!id) return undefined;
  return decision.options.find((option) => option.id === id);
}

export function isExactDecisionSelection(
  answer: string,
  decision: PendingUserDecision | undefined,
  legacyPendingPrompt?: string,
): boolean {
  const id = exactOptionIdFromAnswer(answer);
  if (decision) return Boolean(id && decision.options.some((option) => option.id === id));
  if (id) return true;
  return Boolean(legacyPendingPrompt?.trim()) && /^[1-4]\s*[。.!！?？]?$/.test(answer.trim());
}

export function renderUserDirectionForPlanner(answer: string, decision: PendingUserDecision | undefined): string {
  const selected = selectedDecisionOption(decision, answer);
  return [
    'User direction (raw, do not rewrite):',
    answer,
    decision ? '' : undefined,
    decision ? 'Decision context:' : undefined,
    decision ? `Question: ${decision.question}` : undefined,
    selected ? `Selected option: ${selected.id}. ${selected.label}` : undefined,
    selected ? `Selected option impact: ${selected.impact}` : undefined,
    decision && !selected ? 'Selected option: free-form answer / no exact A-D option selected' : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');
}

export function renderUserDirectionLog(answer: string, decision: PendingUserDecision | undefined): string {
  const selected = selectedDecisionOption(decision, answer);
  return [
    `user direction: ${answer}`,
    decision ? `decision id: ${decision.id}` : undefined,
    decision ? `decision source: ${decision.source}` : undefined,
    decision ? `decision question: ${decision.question}` : undefined,
    selected ? `selected option: ${selected.id}. ${selected.label}` : undefined,
    selected ? `selected impact: ${selected.impact}` : undefined,
    decision && !selected ? 'selected option: free-form / no exact A-D match' : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stripDecisionBlocks(markdown: string): string {
  return markdown
    .replace(DECISION_BLOCK_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasUnstructuredUserDecisionMarker(markdown: string): boolean {
  return markdown.split(/\r?\n/).some((line) => {
    if (isNegatedUserDecisionLine(line)) return false;
    return /\b(?:NEEDS_USER_DECISION|USER_DECISION_REQUIRED)\b/i.test(line)
      || /\b(?:needs|requires)\s+(?:a\s+)?user decision\b/i.test(line)
      || /(?:需要|必须由)用户(?:决定|决策|拍板)/.test(line);
  });
}

function isNegatedUserDecisionLine(line: string): boolean {
  return /\bno\s+user decision\b/i.test(line)
    || /\bnot\s+require\s+(?:a\s+)?user decision\b/i.test(line)
    || /\bdoes\s+not\s+require\s+(?:a\s+)?user decision\b/i.test(line)
    || /\bdoesn't\s+require\s+(?:a\s+)?user decision\b/i.test(line)
    || /(?:不需要|无需).*(?:用户)?(?:决定|决策|拍板)/.test(line);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionIdValue(value: unknown): UserDecisionOptionId | undefined {
  const normalized = stringValue(value)?.toUpperCase();
  return normalized === 'A' || normalized === 'B' || normalized === 'C' || normalized === 'D' ? normalized : undefined;
}

function exactOptionIdFromAnswer(answer: string): UserDecisionOptionId | undefined {
  const normalized = answer.trim().toUpperCase().replace(/[。.!！?？]\s*$/, '').trim();
  return optionIdValue(normalized);
}

function sourceLabel(source: PendingUserDecisionSource): string {
  switch (source) {
    case 'plan_revision':
      return 'Assistant Elon Ma plan revision';
    case 'plan_explanation':
      return 'Assistant Elon Ma plan explanation';
    case 'final_review':
      return 'Final Review Advisor';
    case 'extra_high_planning':
      return 'Extra High planning review';
    case 'plan_artifact_failure':
      return 'Plan artifact failure';
    case 'architect_plan':
      return 'Architect plan';
    case 'plan_review':
      return 'Plan Reviewer';
  }
}

function decisionSourceActor(source: PendingUserDecisionSource): string {
  switch (source) {
    case 'architect_plan':
      return 'Architect';
    case 'plan_review':
      return 'Plan Reviewer';
    case 'final_review':
      return 'Final Review Advisor';
    case 'extra_high_planning':
      return 'Extra High planning review';
    case 'plan_artifact_failure':
      return 'Plan artifact failure';
    case 'plan_revision':
    case 'plan_explanation':
      return 'Assistant Elon Ma';
  }
}

function slug(value: string): string {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'decision';
}

function shorten(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 16)).trimEnd()}\n[truncated]`;
}
