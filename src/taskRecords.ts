import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { sanitizeTextForArtifact } from './textSanitizer.js';
import type {
  ExecutionMode,
  ExecutionUnitDraft,
  ExecutionUnitState,
  ExecutionUnitStatus,
  ProjectConfig,
  TaskCategory,
  TaskState,
  VerificationCommandResult,
} from './types.js';
import {
  TOKEN_USAGE_FILE_NAME,
  createEmptyTaskUsageLedger,
  readTaskUsageLedger,
  summarizeTaskUsageLedger,
  writeTaskUsageLedger,
  type TokenUsageTotals,
} from './taskUsage.js';

export const SUPPORTED_TASK_CATEGORIES = [
  'Reader Core',
  'Selection / Popup',
  'Vocabulary Algorithm',
  'Translation / LLM',
  'Feedback / User Model',
  'Storage / Persistence',
  'Backend / API',
  'Data / Dictionary Pipeline',
  'Evaluation / Benchmark',
  'Assistant / Workflow',
  'Docs / Task Record',
  'UI / Frontend',
  'Other',
] as const satisfies readonly TaskCategory[];

const GLOBAL_START = '<!-- assistant-task-records:start -->';
const GLOBAL_END = '<!-- assistant-task-records:end -->';
const PENDING = 'Pending';

const STANDARD_PARENT_FILES = [
  'plan.md',
  'plan-review.md',
  'implementation-log.md',
  'final-review.md',
  'task-record.md',
] as const;

const REQUIRED_SUBTASK_SECTIONS = [
  '## Status',
  '## Goal',
  '## Scope',
  '## Dependencies',
  '## Expected Behavior',
  '## Files Likely Involved',
  '## Allowed Files / Expected Files',
  '## Implementation Notes',
  '## Acceptance Criteria',
  '## Test Plan',
  '## Test Result',
] as const;

const REQUIRED_TASK_RECORD_SECTIONS = [
  '## Summary',
  '## User Acceptance',
  '## Implementation Process',
  '## Files Changed',
  '## Behavior Changed',
  '## Algorithm Logic',
  '## Connected Systems',
  '## Reserved Interfaces / Future Hooks',
  '## Tests Run',
  '## Known Remaining Issues',
  '## Future Follow-ups',
] as const;

export function normalizeTaskCategory(category: string | undefined): TaskCategory {
  const normalized = category?.trim().toLocaleLowerCase();
  return SUPPORTED_TASK_CATEGORIES.find((entry) => entry.toLocaleLowerCase() === normalized) ?? 'Other';
}

export function resolveTaskRecordRoot(project: ProjectConfig): string {
  if (!project.taskRecordRoot) return resolve(project.targetDir, 'task');
  return isAbsolute(project.taskRecordRoot)
    ? project.taskRecordRoot
    : resolve(project.targetDir, project.taskRecordRoot);
}

export function makeExecutionUnits(drafts: ExecutionUnitDraft[] | undefined): ExecutionUnitState[] {
  const usableDrafts = drafts?.filter((draft) => draft.name.trim().length > 0) ?? [];
  const normalizedDrafts = usableDrafts.length > 0 ? usableDrafts : [{ name: 'Main' }];
  const single = normalizedDrafts.length === 1;
  return normalizedDrafts.map((draft, index) => {
    const number = index + 1;
    const slug = single ? 'main' : slugify(draft.name) || `task-${number}`;
    return {
      index: number,
      slug,
      name: single ? 'Main' : draft.name.trim(),
      status: 'Not Started',
      fileName: `${String(number).padStart(2, '0')}-${slug}.md`,
    };
  });
}

export function executionModeFor(units: ExecutionUnitState[]): ExecutionMode {
  return units.length <= 1 ? 'single' : 'decomposed';
}

export interface ParentTaskRenderInput {
  state: TaskState;
  project: ProjectConfig;
  originalRequest: string;
  planSummary?: string;
  queueSummary?: string;
  testSummary?: string;
  finalReviewStatus?: string;
  userAcceptanceStatus?: string;
  finalCompletionStatus?: string;
}

export interface ApprovedPlanInput {
  state: TaskState;
  project: ProjectConfig;
  planMarkdown: string;
  reviewMarkdown: string;
  executionUnitDrafts?: ExecutionUnitDraft[];
}

export interface TaskRecordFinalizeInput {
  state: TaskState;
  project: ProjectConfig;
  originalRequest: string;
  implementationLog: string;
  verificationLog: string;
  finalReview: string;
  beforeStatus: string;
  afterStatus: string;
}

interface GlobalTaskRow {
  taskId: string;
  task: string;
  category: string;
  status: string;
  executionMode: string;
  summary: string;
  updated: string;
}

export class TaskRecordStore {
  async initializeParentTask(input: ParentTaskRenderInput): Promise<void> {
    const parentDir = parentTaskDir(input.project, input.state.taskId);
    await mkdir(join(parentDir, 'subtasks'), { recursive: true });
    await mkdir(join(parentDir, 'artifacts'), { recursive: true });
    for (const file of STANDARD_PARENT_FILES) {
      await writePlaceholderIfMissing(join(parentDir, file));
    }
    await writeInitialTokenUsageLedger(input.project, input.state);
    await this.writeParentReadme(input);
    await this.updateGlobalReadme(input.project, input.state);
  }

  async persistApprovedPlan(input: ApprovedPlanInput): Promise<ExecutionUnitState[]> {
    const parentDir = parentTaskDir(input.project, input.state.taskId);
    await mkdir(join(parentDir, 'subtasks'), { recursive: true });
    await writeFile(join(parentDir, 'plan.md'), ensureTrailingNewline(sanitizeTextForArtifact(input.planMarkdown)), 'utf8');
    await writeFile(join(parentDir, 'plan-review.md'), ensureTrailingNewline(sanitizeTextForArtifact(input.reviewMarkdown || PENDING)), 'utf8');

    const units = makeExecutionUnits(input.executionUnitDrafts);
    const drafts = input.executionUnitDrafts?.filter((draft) => draft.name.trim().length > 0) ?? [];
    await Promise.all(units.map((unit, index) => {
      const draft = drafts[index];
      const markdown = sanitizeTextForArtifact(normalizeSubtaskMarkdown(unit, draft?.markdown));
      const errors = validateSubtaskMarkdown(markdown);
      if (errors.length > 0) {
        throw new Error(`Invalid subtask markdown for ${unit.fileName}: ${errors.join('; ')}`);
      }
      return writeFile(
        join(parentDir, 'subtasks', unit.fileName),
        ensureTrailingNewline(markdown),
        'utf8',
      );
    }));
    return units;
  }

  async markExecutionUnit(
    project: ProjectConfig,
    state: TaskState,
    unit: ExecutionUnitState,
    status: ExecutionUnitStatus,
    testResult?: string,
  ): Promise<void> {
    const path = join(parentTaskDir(project, state.taskId), 'subtasks', unit.fileName);
    const previous = await readFile(path, 'utf8');
    const withStatus = replaceSection(previous, '## Status', status);
    const next = testResult ? replaceSection(withStatus, '## Test Result', testResult) : withStatus;
    await writeFile(path, ensureTrailingNewline(sanitizeTextForArtifact(next)), 'utf8');
  }

  async appendImplementationLog(project: ProjectConfig, state: TaskState, content: string): Promise<void> {
    const path = join(parentTaskDir(project, state.taskId), 'implementation-log.md');
    const previous = await readFile(path, 'utf8').catch(() => '');
    const cleanContent = sanitizeTextForArtifact(content);
    const body = previous.trim() && previous.trim() !== PENDING
      ? `${previous.trimEnd()}\n\n${cleanContent}`
      : cleanContent;
    await writeFile(path, ensureTrailingNewline(sanitizeTextForArtifact(body)), 'utf8');
  }

  async writeFinalReview(project: ProjectConfig, state: TaskState, finalReview: string): Promise<void> {
    const parentDir = parentTaskDir(project, state.taskId);
    await mkdir(parentDir, { recursive: true });
    await writeFile(join(parentDir, 'final-review.md'), ensureTrailingNewline(sanitizeTextForArtifact(finalReview)), 'utf8');
  }

  async finalizeTaskRecord(input: TaskRecordFinalizeInput): Promise<void> {
    const markdown = sanitizeTextForArtifact(renderTaskRecord(input));
    const path = join(parentTaskDir(input.project, input.state.taskId), 'task-record.md');
    await writeFile(path, ensureTrailingNewline(markdown), 'utf8');
    const errors = validateTaskRecordMarkdown(markdown);
    if (errors.length > 0) {
      throw new Error(`Cannot complete task without a valid task-record.md: ${errors.join('; ')}`);
    }
  }

  async writeParentReadme(input: ParentTaskRenderInput): Promise<void> {
    await mkdir(parentTaskDir(input.project, input.state.taskId), { recursive: true });
    const tokenUsageSection = await renderTokenUsageSection(input.project, input.state);
    const markdown = sanitizeTextForArtifact(renderParentReadme(input, tokenUsageSection));
    const errors = validateParentReadmeMarkdown(markdown);
    if (errors.length > 0) {
      throw new Error(`Invalid parent task README: ${errors.join('; ')}`);
    }
    await writeFile(
      join(parentTaskDir(input.project, input.state.taskId), 'README.md'),
      ensureTrailingNewline(markdown),
      'utf8',
    );
  }

  async updateGlobalReadme(project: ProjectConfig, state: TaskState): Promise<void> {
    const root = resolveTaskRecordRoot(project);
    await mkdir(root, { recursive: true });
    const readmePath = join(root, 'README.md');
    const existing = await readFile(readmePath, 'utf8').catch(() => '');
    const rows = parseGlobalRows(existing).filter((row) => row.taskId !== state.taskId);
    rows.push({
      taskId: state.taskId,
      task: `[${escapeTableCell(state.title)}](${state.taskId}/README.md)`,
      category: state.category,
      status: state.status,
      executionMode: state.executionMode ?? PENDING,
      summary: escapeTableCell(state.planSummary ?? PENDING),
      updated: state.updatedAt,
    });
    const legacy = extractLegacyGlobalReadme(existing);
    await writeFile(readmePath, ensureTrailingNewline(sanitizeTextForArtifact(renderGlobalReadme(rows, legacy))), 'utf8');
  }

  async hasValidTaskRecord(project: ProjectConfig, state: TaskState): Promise<boolean> {
    const markdown = await readFile(join(parentTaskDir(project, state.taskId), 'task-record.md'), 'utf8').catch(() => '');
    return validateTaskRecordMarkdown(markdown).length === 0;
  }
}

export function validateSubtaskMarkdown(markdown: string): string[] {
  const errors: string[] = [];
  if (!/^# Task \d{2}: .+/m.test(markdown)) errors.push('Missing "# Task XX: <name>" heading.');
  for (const section of REQUIRED_SUBTASK_SECTIONS) {
    if (!markdown.includes(section)) errors.push(`Missing ${section}.`);
  }
  return errors;
}

export function validateParentReadmeMarkdown(markdown: string): string[] {
  const required = [
    '## Task Info',
    '| Task ID |',
    '| Title |',
    '| Category |',
    '| Status |',
    '| Execution Mode |',
    '## Original Request',
    '## Plan Summary',
    '## Queue Summary',
    '## Subtask Status',
    '## Token Usage',
    '## Test Summary',
    '## Final Review Status',
    '## User Acceptance Status',
    '## Final Completion Status',
  ];
  return required.filter((entry) => !markdown.includes(entry)).map((entry) => `Missing ${entry}.`);
}

export function validateTaskRecordMarkdown(markdown: string): string[] {
  const errors: string[] = [];
  if (!/^# Task Record: .+/m.test(markdown)) errors.push('Missing task record title.');
  for (const section of REQUIRED_TASK_RECORD_SECTIONS) {
    if (!markdown.includes(section)) errors.push(`Missing ${section}.`);
  }
  if (!/## User Acceptance\s+[\s\S]*Accepted/im.test(markdown)) {
    errors.push('Task record must include accepted user acceptance.');
  }
  if (markdown.trim() === PENDING) errors.push('Task record is still pending.');
  return errors;
}

export function renderTestResult(results: VerificationCommandResult[]): string {
  const commands = results.length > 0
    ? results.map((result) => `- ${result.command}: ${result.status}`).join('\n')
    : '- No verification commands were proposed.';
  const focusedPassed = results.some((result) => /test/i.test(result.command) && result.status === 'passed') ? 'Yes' : 'No';
  const build = results.find((result) => /build/i.test(result.command));
  return [
    `- Scenarios tested: Current execution unit verification commands.`,
    `- Pass/fail status: ${results.every((result) => result.status === 'passed' || result.status === 'skipped') ? 'Passed or skipped' : 'Failed or blocked'}`,
    '- Failure reason if any: See command output in `test-build-log.md`.',
    '- Known remaining issues: Pending final review.',
    '- Commands run:',
    commands,
    `- Focused tests passed: ${focusedPassed}`,
    `- Build passed if build was run: ${build ? (build.status === 'passed' ? 'Yes' : 'No') : 'Build not run'}`,
  ].join('\n');
}

function parentTaskDir(project: ProjectConfig, taskId: string): string {
  return join(resolveTaskRecordRoot(project), taskId);
}

function tokenUsagePath(project: ProjectConfig, taskId: string): string {
  return join(parentTaskDir(project, taskId), TOKEN_USAGE_FILE_NAME);
}

async function writeInitialTokenUsageLedger(project: ProjectConfig, state: TaskState): Promise<void> {
  const path = tokenUsagePath(project, state.taskId);
  const existing = await readFile(path, 'utf8').catch(() => undefined);
  if (existing !== undefined) return;

  await writeTaskUsageLedger(path, createEmptyTaskUsageLedger({
    taskId: state.taskId,
    taskTitle: state.title,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  }));
}

async function writePlaceholderIfMissing(path: string): Promise<void> {
  const existing = await readFile(path, 'utf8').catch(() => undefined);
  if (existing === undefined) await writeFile(path, `${PENDING}\n`, 'utf8');
}

function renderParentReadme(input: ParentTaskRenderInput, tokenUsageSection: string): string {
  const state = input.state;
  const subtaskRows = state.executionQueue.length > 0
    ? state.executionQueue.map((unit) => `| [${String(unit.index).padStart(2, '0')} - ${escapeTableCell(unit.name)}](subtasks/${unit.fileName}) | ${unit.status} |`).join('\n')
    : `| ${PENDING} | ${PENDING} |`;

  return [
    `# ${state.title}`,
    '',
    '## Task Info',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Task ID | ${escapeTableCell(state.taskId)} |`,
    `| Title | ${escapeTableCell(state.title)} |`,
    `| Category | ${state.category} |`,
    `| Status | ${state.status} |`,
    `| Execution Mode | ${state.executionMode ?? PENDING} |`,
    '',
    '## Original Request',
    '',
    input.originalRequest.trim() || PENDING,
    '',
    '## Plan Summary',
    '',
    input.planSummary ?? state.planSummary ?? PENDING,
    '',
    '## Queue Summary',
    '',
    input.queueSummary ?? renderQueueSummary(state),
    '',
    '## Subtask Status',
    '',
    '| Subtask | Status |',
    '|---|---|',
    subtaskRows,
    '',
    '## Token Usage',
    '',
    tokenUsageSection,
    '',
    '## Test Summary',
    '',
    input.testSummary ?? PENDING,
    '',
    '## Final Review Status',
    '',
    input.finalReviewStatus ?? PENDING,
    '',
    '## User Acceptance Status',
    '',
    input.userAcceptanceStatus ?? renderUserAcceptanceStatus(state),
    '',
    '## Final Completion Status',
    '',
    input.finalCompletionStatus ?? (state.status === 'completed' ? 'Completed' : PENDING),
  ].join('\n');
}

async function renderTokenUsageSection(project: ProjectConfig, state: TaskState): Promise<string> {
  const usagePath = tokenUsagePath(project, state.taskId);
  const ledger = await readTaskUsageLedger(usagePath).catch(() => undefined);
  if (!ledger) {
    return [
      `Ledger: \`${TOKEN_USAGE_FILE_NAME}\``,
      '',
      'No token usage ledger is available yet.',
    ].join('\n');
  }

  const summary = summarizeTaskUsageLedger(ledger, { usagePath });
  if (summary.totals.entries === 0) {
    return [
      `Ledger: [${TOKEN_USAGE_FILE_NAME}](${TOKEN_USAGE_FILE_NAME})`,
      '',
      'No token usage entries recorded yet. Usage is unknown, not zero.',
      '',
      `Query usage from this workflow repo: \`npm run assistant -- usage --task ${state.taskId} --by role\``,
    ].join('\n');
  }

  return [
    `Ledger: [${TOKEN_USAGE_FILE_NAME}](${TOKEN_USAGE_FILE_NAME})`,
    '',
    '| Entries | Total Tokens | Input | Output | Reasoning | Cached | Known Cost | Unknown Cost Entries | Accuracy |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    `| ${summary.totals.entries} | ${summary.totals.totalTokens} | ${summary.totals.inputTokens} | ${summary.totals.outputTokens} | ${summary.totals.reasoningTokens} | ${summary.totals.cachedInputTokens} | ${summary.currency} ${summary.totals.knownCost.toFixed(6)} | ${summary.totals.costUnknownEntries} | ${formatAccuracy(summary.totals)} |`,
    '',
    `Query usage from this workflow repo: \`npm run assistant -- usage --task ${state.taskId} --by role\``,
  ].join('\n');
}

function formatAccuracy(totals: TokenUsageTotals): string {
  if (totals.entries === 0) return 'no entries';
  const percent = (count: number) => `${((count / totals.entries) * 100).toFixed(1)}%`;
  return `actual ${percent(totals.actualEntries)}, estimated ${percent(totals.estimatedEntries)}, unknown ${percent(totals.unknownEntries)}`;
}

function renderQueueSummary(state: TaskState): string {
  if (state.executionQueue.length === 0) return PENDING;
  const done = state.executionQueue.filter((unit) => unit.status === 'Done').length;
  return `${done}/${state.executionQueue.length} execution units done.`;
}

function renderUserAcceptanceStatus(state: TaskState): string {
  if (state.acceptedAt) return `Accepted at ${state.acceptedAt}.`;
  if (state.userAcceptanceNotes.length > 0) return `Awaiting acceptance. Notes: ${state.userAcceptanceNotes.join(' | ')}`;
  return PENDING;
}

function normalizeSubtaskMarkdown(unit: ExecutionUnitState, markdown: string | undefined): string {
  const base = markdown?.trim()
    ? markdown.trim()
    : [
      `# Task ${String(unit.index).padStart(2, '0')}: ${unit.name}`,
      '',
      '## Status',
      unit.status,
      '',
      '## Goal',
      PENDING,
      '',
      '## Scope',
      PENDING,
      '',
      '## Dependencies',
      PENDING,
      '',
      '## Expected Behavior',
      PENDING,
      '',
      '## Files Likely Involved',
      PENDING,
      '',
      '## Allowed Files / Expected Files',
      PENDING,
      '',
      '## Implementation Notes',
      PENDING,
      '',
      '## Acceptance Criteria',
      PENDING,
      '',
      '## Test Plan',
      PENDING,
      '',
      '## Test Result',
      PENDING,
    ].join('\n');

  let next = /^# Task \d{2}: .+/m.test(base)
    ? base
    : [`# Task ${String(unit.index).padStart(2, '0')}: ${unit.name}`, '', base].join('\n');
  for (const section of REQUIRED_SUBTASK_SECTIONS) {
    if (!next.includes(section)) next = `${next.trimEnd()}\n\n${section}\n${section === '## Status' ? unit.status : PENDING}`;
  }
  next = replaceSection(next, '## Status', unit.status);
  return next;
}

function replaceSection(markdown: string, heading: string, content: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${escaped}\\n)([\\s\\S]*?)(?=\\n## |$)`);
  if (!pattern.test(markdown)) return `${markdown.trimEnd()}\n\n${heading}\n${content}`;
  return markdown.replace(pattern, `$1${content.trim()}\n`);
}

function renderTaskRecord(input: TaskRecordFinalizeInput): string {
  const state = input.state;
  const filesChanged = diffStatusLines(input.beforeStatus, input.afterStatus);
  return [
    `# Task Record: ${state.title}`,
    '',
    '## Summary',
    '',
    state.planSummary ?? 'The approved assistant task was implemented and accepted.',
    '',
    '## User Acceptance',
    '',
    `Accepted at ${state.acceptedAt ?? new Date().toISOString()}.`,
    state.userAcceptanceNotes.length > 0 ? `User notes: ${state.userAcceptanceNotes.join(' | ')}` : 'User notes: None.',
    '',
    '## Implementation Process',
    '',
    'Plan, sequential execution, final review, and user acceptance were completed through Assistant Elon Ma.',
    '',
    '## Files Changed',
    '',
    filesChanged.length > 0 ? filesChanged.join('\n') : 'No new git status entries relative to the pre-implementation snapshot.',
    '',
    '## Behavior Changed',
    '',
    input.implementationLog.trim() || PENDING,
    '',
    '## Algorithm Logic',
    '',
    'No specific product algorithm was recorded by Assistant Elon Ma for this task unless noted in the implementation log.',
    '',
    '## Connected Systems',
    '',
    'See implementation log and final review for connected systems.',
    '',
    '## Reserved Interfaces / Future Hooks',
    '',
    'No reserved interfaces or future hooks were recorded unless noted in the implementation log.',
    '',
    '## Tests Run',
    '',
    input.verificationLog.trim() || PENDING,
    '',
    '## Known Remaining Issues',
    '',
    input.finalReview.trim() || 'None recorded by final review.',
    '',
    '## Future Follow-ups',
    '',
    'None recorded.',
  ].join('\n');
}

function parseGlobalRows(markdown: string): GlobalTaskRow[] {
  const section = between(markdown, GLOBAL_START, GLOBAL_END) ?? markdown;
  return section.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('|') || line.includes('---') || line.includes('| Task |')) return [];
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6) return [];
    const taskId = cells[0]?.match(/\(([^/)]+)\/README\.md\)/)?.[1];
    if (!taskId) return [];
    return [{
      taskId,
      task: cells[0] ?? '',
      category: cells[1] ?? PENDING,
      status: cells[2] ?? PENDING,
      executionMode: cells[3] ?? PENDING,
      summary: cells[4] ?? PENDING,
      updated: cells[5] ?? PENDING,
    }];
  });
}

function renderGlobalReadme(rows: GlobalTaskRow[], legacy: string): string {
  const sorted = [...rows].sort((a, b) => a.updated.localeCompare(b.updated));
  return [
    '# Task Records',
    '',
    'This folder contains implementation records grouped by task.',
    '',
    '## Token Usage Ledgers',
    '',
    `New assistant task folders include a \`${TOKEN_USAGE_FILE_NAME}\` file for machine-readable token and cost accounting.`,
    '',
    '- Treat the ledger as the source of truth for token/cost questions.',
    '- Record usage by role, subtask, and step when usage is available.',
    '- Use `accuracy: "actual"` only for platform/API usage, `estimated` for documented estimates, and `unknown` when usage is not exposed.',
    '- Do not backfill fake numbers for historical tasks.',
    '',
    GLOBAL_START,
    '## Tasks',
    '',
    '| Task | Category | Status | Execution Mode | Summary | Updated |',
    '|---|---|---|---|---|---|',
    ...(sorted.length > 0
      ? sorted.map((row) => `| ${row.task} | ${row.category} | ${row.status} | ${row.executionMode} | ${row.summary} | ${row.updated} |`)
      : ['| Pending | Other | Pending | Pending | Pending | Pending |']),
    GLOBAL_END,
    legacy ? ['', '## Existing / Legacy Records', '', legacy] : '',
  ].filter((part) => part !== '').join('\n');
}

function extractLegacyGlobalReadme(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return '';
  const existingLegacy = markdown.match(/## Existing \/ Legacy Records\s+([\s\S]*)$/);
  if (existingLegacy?.[1]?.trim()) return existingLegacy[1].trim();
  if (markdown.includes(GLOBAL_START) && markdown.includes(GLOBAL_END)) return '';
  return trimmed;
}

function between(value: string, start: string, end: string): string | undefined {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return undefined;
  return value.slice(startIndex + start.length, endIndex);
}

function diffStatusLines(before: string, after: string): string[] {
  const beforeSet = new Set(before.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return after.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !beforeSet.has(line));
}

function slugify(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function ensureTrailingNewline(value: string): string {
  return `${value.trimEnd()}\n`;
}
