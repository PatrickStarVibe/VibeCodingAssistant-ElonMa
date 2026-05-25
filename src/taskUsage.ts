import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOKEN_USAGE_FILE_NAME = 'token-usage.json';

export type TokenUsageRole =
  | 'assistant_planning'
  | 'implementation'
  | 'review_debug'
  | 'verification'
  | 'documentation'
  | 'delegated_worker'
  | 'delegated_explorer'
  | 'tooling_api';

export type TokenUsageAccuracy = 'actual' | 'estimated' | 'unknown';

export type TaskUsageBreakdownKey = 'role' | 'subtask' | 'step';

export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export interface TokenUsagePricingSnapshot {
  inputTokenCostPer1K?: number;
  outputTokenCostPer1K?: number;
  requestBaseCost?: number;
  currency?: string;
  source?: string;
  capturedAt?: string;
}

export interface TokenUsageCost {
  inputCost?: number;
  outputCost?: number;
  requestCost?: number;
  totalCost?: number;
  currency?: string;
  source?: 'provider_billing' | 'pricing_snapshot' | 'manual' | 'unknown';
}

export interface TaskUsageEntry {
  subtaskId: string;
  role: TokenUsageRole;
  stepId: string;
  stepTitle: string;
  provider?: string;
  model?: string;
  source?: string;
  accuracy: TokenUsageAccuracy;
  startedAt?: string;
  endedAt?: string;
  tokens?: TokenCounts;
  pricingSnapshot?: TokenUsagePricingSnapshot;
  cost?: TokenUsageCost;
  notes?: string;
}

export interface TaskUsageLedger {
  schemaVersion: number;
  taskId: string;
  taskTitle: string;
  createdAt: string;
  updatedAt: string;
  currency?: string;
  totals?: unknown;
  rollups?: unknown;
  entries: TaskUsageEntry[];
}

export interface TokenUsageTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  knownCost: number;
  costUnknownEntries: number;
  entries: number;
  actualEntries: number;
  estimatedEntries: number;
  unknownEntries: number;
}

export interface TokenUsageBreakdownRow extends TokenUsageTotals {
  key: string;
}

export interface TaskUsageSummary {
  taskId: string;
  taskTitle: string;
  updatedAt: string;
  currency: string;
  usagePath: string;
  totals: TokenUsageTotals;
  entries: TaskUsageEntry[];
  breakdown?: {
    by: TaskUsageBreakdownKey;
    rows: TokenUsageBreakdownRow[];
  };
}

export interface TaskUsageCliOptions {
  cwd?: string;
}

export interface CreateTaskUsageLedgerInput {
  taskId: string;
  taskTitle: string;
  createdAt: string;
  updatedAt: string;
  currency?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function entryTotalTokens(tokens: TokenCounts | undefined): number {
  if (!tokens) return 0;
  const explicitTotal = readNumber(tokens.totalTokens);
  if (explicitTotal > 0) return explicitTotal;
  return readNumber(tokens.inputTokens) + readNumber(tokens.outputTokens) + readNumber(tokens.reasoningTokens);
}

function costFromPricingSnapshot(entry: TaskUsageEntry): number | null {
  const snapshot = entry.pricingSnapshot;
  if (!snapshot) return null;

  const inputRate = readNonNegativeNumber(snapshot.inputTokenCostPer1K);
  const outputRate = readNonNegativeNumber(snapshot.outputTokenCostPer1K);
  const requestBaseCost = readNonNegativeNumber(snapshot.requestBaseCost);
  if (inputRate === undefined && outputRate === undefined && requestBaseCost === undefined) return null;

  const inputCost = (readNumber(entry.tokens?.inputTokens) / 1000) * (inputRate ?? 0);
  const outputCost = (readNumber(entry.tokens?.outputTokens) / 1000) * (outputRate ?? 0);
  return roundMoney(inputCost + outputCost + (requestBaseCost ?? 0));
}

function entryCost(entry: TaskUsageEntry): number | null {
  const explicitTotal = readNonNegativeNumber(entry.cost?.totalCost);
  if (explicitTotal !== undefined) return roundMoney(explicitTotal);

  const partialCosts = [
    readNonNegativeNumber(entry.cost?.inputCost),
    readNonNegativeNumber(entry.cost?.outputCost),
    readNonNegativeNumber(entry.cost?.requestCost),
  ].filter((value): value is number => value !== undefined);
  if (partialCosts.length > 0) {
    return roundMoney(partialCosts.reduce((total, value) => total + value, 0));
  }

  return costFromPricingSnapshot(entry);
}

function emptyTotals(): TokenUsageTotals {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    knownCost: 0,
    costUnknownEntries: 0,
    entries: 0,
    actualEntries: 0,
    estimatedEntries: 0,
    unknownEntries: 0,
  };
}

function addEntryToTotals(totals: TokenUsageTotals, entry: TaskUsageEntry): void {
  totals.entries += 1;
  totals.totalTokens += entryTotalTokens(entry.tokens);
  totals.inputTokens += readNumber(entry.tokens?.inputTokens);
  totals.outputTokens += readNumber(entry.tokens?.outputTokens);
  totals.reasoningTokens += readNumber(entry.tokens?.reasoningTokens);
  totals.cachedInputTokens += readNumber(entry.tokens?.cachedInputTokens);

  if (entry.accuracy === 'actual') totals.actualEntries += 1;
  if (entry.accuracy === 'estimated') totals.estimatedEntries += 1;
  if (entry.accuracy === 'unknown') totals.unknownEntries += 1;

  const cost = entryCost(entry);
  if (cost === null) {
    totals.costUnknownEntries += 1;
  } else {
    totals.knownCost = roundMoney(totals.knownCost + cost);
  }
}

function groupKey(entry: TaskUsageEntry, by: TaskUsageBreakdownKey): string {
  if (by === 'role') return entry.role;
  if (by === 'subtask') return entry.subtaskId;
  return entry.stepId ? `${entry.stepId} ${entry.stepTitle}`.trim() : entry.stepTitle;
}

function summarizeEntries(entries: TaskUsageEntry[]): TokenUsageTotals {
  const totals = emptyTotals();
  for (const entry of entries) addEntryToTotals(totals, entry);
  return totals;
}

function summarizeBy(entries: TaskUsageEntry[], by: TaskUsageBreakdownKey): TokenUsageBreakdownRow[] {
  const groups = new Map<string, TokenUsageTotals>();
  for (const entry of entries) {
    const key = groupKey(entry, by);
    const totals = groups.get(key) ?? emptyTotals();
    addEntryToTotals(totals, entry);
    groups.set(key, totals);
  }

  return [...groups.entries()]
    .map(([key, totals]) => ({ key, ...totals }))
    .sort((left, right) => right.totalTokens - left.totalTokens || left.key.localeCompare(right.key));
}

function validateLedger(value: unknown, usagePath: string): TaskUsageLedger {
  if (!isRecord(value)) {
    throw new Error(`${usagePath} must contain a JSON object.`);
  }
  if (typeof value.taskId !== 'string' || !value.taskId.trim()) {
    throw new Error(`${usagePath} is missing taskId.`);
  }
  if (typeof value.taskTitle !== 'string' || !value.taskTitle.trim()) {
    throw new Error(`${usagePath} is missing taskTitle.`);
  }
  if (typeof value.updatedAt !== 'string' || !value.updatedAt.trim()) {
    throw new Error(`${usagePath} is missing updatedAt.`);
  }
  if (!Array.isArray(value.entries)) {
    throw new Error(`${usagePath} is missing entries.`);
  }

  return value as unknown as TaskUsageLedger;
}

export async function readTaskUsageLedger(usagePath: string): Promise<TaskUsageLedger> {
  let content: string;
  try {
    content = await readFile(usagePath, 'utf8');
  } catch {
    throw new Error(`Token usage ledger not found: ${usagePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error(`Token usage ledger is not valid JSON: ${usagePath}`);
  }

  return validateLedger(parsed, usagePath);
}

export function createEmptyTaskUsageLedger(input: CreateTaskUsageLedgerInput): TaskUsageLedger {
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    currency: input.currency ?? 'USD',
    totals: emptyTotals(),
    rollups: {
      byRole: {},
      bySubtask: {},
      byStep: {},
    },
    entries: [],
  };
}

export async function writeTaskUsageLedger(usagePath: string, ledger: TaskUsageLedger): Promise<void> {
  await writeFile(usagePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

export function summarizeTaskUsageLedger(
  ledger: TaskUsageLedger,
  options: { usagePath: string; by?: TaskUsageBreakdownKey },
): TaskUsageSummary {
  const currency = ledger.currency ?? 'USD';
  return {
    taskId: ledger.taskId,
    taskTitle: ledger.taskTitle,
    updatedAt: ledger.updatedAt,
    currency,
    usagePath: options.usagePath,
    totals: summarizeEntries(ledger.entries),
    entries: ledger.entries,
    ...(options.by ? { breakdown: { by: options.by, rows: summarizeBy(ledger.entries, options.by) } } : {}),
  };
}

async function collectUsageFiles(root: string): Promise<string[]> {
  const children = await readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (!children) return [];

  const files: string[] = [];
  for (const child of children) {
    const childPath = join(root, child.name);
    if (child.isDirectory()) {
      files.push(...await collectUsageFiles(childPath));
    } else if (child.isFile() && child.name === TOKEN_USAGE_FILE_NAME) {
      files.push(childPath);
    }
  }
  return files;
}

export async function findLatestTaskUsagePath(taskRoot: string): Promise<string> {
  const usageFiles = await collectUsageFiles(taskRoot);
  if (usageFiles.length === 0) {
    throw new Error(`No ${TOKEN_USAGE_FILE_NAME} files found under ${taskRoot}.`);
  }

  const firstUsagePath = usageFiles[0];
  if (!firstUsagePath) {
    throw new Error(`No ${TOKEN_USAGE_FILE_NAME} files found under ${taskRoot}.`);
  }

  let latestPath = firstUsagePath;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const usagePath of usageFiles) {
    const ledger = await readTaskUsageLedger(usagePath);
    const updatedAt = Date.parse(ledger.updatedAt);
    const fallbackMtime = Number.isNaN(updatedAt) ? (await stat(usagePath)).mtimeMs : updatedAt;
    if (fallbackMtime > latestTime) {
      latestPath = usagePath;
      latestTime = fallbackMtime;
    }
  }
  return latestPath;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatCost(value: number, currency: string, unknownEntries: number): string {
  const known = `${currency} ${value.toFixed(6)}`;
  return unknownEntries > 0 ? `${known} (${unknownEntries} entries unknown)` : known;
}

function accuracyText(totals: TokenUsageTotals): string {
  if (totals.entries === 0) return 'no entries';
  const pct = (count: number) => `${((count / totals.entries) * 100).toFixed(1)}%`;
  return `actual ${pct(totals.actualEntries)}, estimated ${pct(totals.estimatedEntries)}, unknown ${pct(totals.unknownEntries)}`;
}

function formatTotals(totals: TokenUsageTotals, currency: string): string[] {
  if (totals.entries === 0) {
    return [
      '- entries: 0',
      '- usage: unknown (no token usage entries recorded; this does not mean zero usage)',
      `- cost: unknown ${currency}`,
    ];
  }

  return [
    `- entries: ${formatNumber(totals.entries)}`,
    `- tokens: total=${formatNumber(totals.totalTokens)}, input=${formatNumber(totals.inputTokens)}, output=${formatNumber(totals.outputTokens)}, reasoning=${formatNumber(totals.reasoningTokens)}, cached=${formatNumber(totals.cachedInputTokens)}`,
    `- cost: ${formatCost(totals.knownCost, currency, totals.costUnknownEntries)}`,
    `- accuracy: ${accuracyText(totals)}`,
  ];
}

function formatBreakdown(summary: TaskUsageSummary): string[] {
  if (!summary.breakdown) return [];

  const lines = [
    '',
    `Breakdown by ${summary.breakdown.by}`,
    '| key | entries | total | input | output | reasoning | cached | cost | accuracy |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];

  for (const row of summary.breakdown.rows) {
    lines.push([
      `| ${row.key}`,
      formatNumber(row.entries),
      formatNumber(row.totalTokens),
      formatNumber(row.inputTokens),
      formatNumber(row.outputTokens),
      formatNumber(row.reasoningTokens),
      formatNumber(row.cachedInputTokens),
      formatCost(row.knownCost, summary.currency, row.costUnknownEntries),
      `${accuracyText(row)} |`,
    ].join(' | '));
  }

  return lines;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatEntryCost(entry: TaskUsageEntry, currency: string): string {
  const cost = entryCost(entry);
  return cost === null ? 'unknown' : `${entry.cost?.currency ?? entry.pricingSnapshot?.currency ?? currency} ${cost.toFixed(6)}`;
}

function formatEntries(summary: TaskUsageSummary): string[] {
  const lines = [
    '',
    'Entries',
  ];

  if (summary.entries.length === 0) {
    lines.push('No token usage entries recorded.');
    return lines;
  }

  lines.push(
    '| subtask | role | step | total | input | output | reasoning | cached | cost | accuracy |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  for (const entry of summary.entries) {
    lines.push([
      `| ${escapeMarkdownTableCell(entry.subtaskId)}`,
      escapeMarkdownTableCell(entry.role),
      escapeMarkdownTableCell(`${entry.stepId} ${entry.stepTitle}`.trim()),
      formatNumber(entryTotalTokens(entry.tokens)),
      formatNumber(readNumber(entry.tokens?.inputTokens)),
      formatNumber(readNumber(entry.tokens?.outputTokens)),
      formatNumber(readNumber(entry.tokens?.reasoningTokens)),
      formatNumber(readNumber(entry.tokens?.cachedInputTokens)),
      formatEntryCost(entry, summary.currency),
      `${entry.accuracy} |`,
    ].join(' | '));
  }
  return lines;
}

export function formatTaskUsageSummary(summary: TaskUsageSummary): string {
  return [
    `Task: ${summary.taskTitle} (${summary.taskId})`,
    `Updated: ${summary.updatedAt}`,
    `Usage file: ${summary.usagePath}`,
    '',
    'Totals',
    ...formatTotals(summary.totals, summary.currency),
    ...formatBreakdown(summary),
    ...(summary.breakdown ? [] : formatEntries(summary)),
  ].join('\n');
}

function parseArgs(argv: string[]): { taskDir?: string; latest: boolean; by?: TaskUsageBreakdownKey } {
  const parsed: { taskDir?: string; latest: boolean; by?: TaskUsageBreakdownKey } = { latest: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--task') {
      const taskDir = argv[index + 1];
      if (!taskDir) throw new Error('--task requires a task directory.');
      parsed.taskDir = taskDir;
      index += 1;
      continue;
    }
    if (arg === '--latest') {
      parsed.latest = true;
      continue;
    }
    if (arg === '--by') {
      const by = argv[index + 1] as TaskUsageBreakdownKey | undefined;
      if (by !== 'role' && by !== 'subtask' && by !== 'step') {
        throw new Error('--by must be one of: role, subtask, step.');
      }
      parsed.by = by;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (parsed.taskDir && parsed.latest) {
    throw new Error('Use either --task <task-dir> or --latest, not both.');
  }
  if (!parsed.taskDir && !parsed.latest) {
    throw new Error('Pass --task <task-dir> or --latest.');
  }

  return parsed;
}

export async function summarizeTaskUsageFromCliArgs(
  argv: string[],
  options: TaskUsageCliOptions = {},
): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const parsed = parseArgs(argv);
  const usagePath = parsed.latest
    ? await findLatestTaskUsagePath(join(cwd, 'task'))
    : join(resolve(cwd, parsed.taskDir ?? ''), TOKEN_USAGE_FILE_NAME);
  const ledger = await readTaskUsageLedger(usagePath);
  return formatTaskUsageSummary(summarizeTaskUsageLedger(
    ledger,
    parsed.by ? { usagePath, by: parsed.by } : { usagePath },
  ));
}

async function main(): Promise<void> {
  try {
    console.info(await summarizeTaskUsageFromCliArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
