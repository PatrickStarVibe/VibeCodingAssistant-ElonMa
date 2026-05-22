import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  TOKEN_USAGE_FILE_NAME,
  findLatestTaskUsagePath,
  formatTaskUsageSummary,
  summarizeTaskUsageFromCliArgs,
  summarizeTaskUsageLedger,
  type TaskUsageLedger,
} from '../summarizeTaskUsage';

function usageLedger(overrides: Partial<TaskUsageLedger> = {}): TaskUsageLedger {
  return {
    schemaVersion: 1,
    taskId: 'manager-token-ledger',
    taskTitle: 'Manager token ledger',
    createdAt: '2026-05-21T12:00:00.000Z',
    updatedAt: '2026-05-21T12:30:00.000Z',
    currency: 'USD',
    totals: {},
    rollups: {},
    entries: [
      {
        subtaskId: '01',
        role: 'implementation',
        stepId: '01-a',
        stepTitle: 'Build aggregator',
        provider: 'openai',
        model: 'gpt-test',
        source: 'api_usage',
        accuracy: 'actual',
        tokens: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 20,
          totalTokens: 150,
        },
        cost: {
          totalCost: 0.01,
          currency: 'USD',
          source: 'provider_billing',
        },
      },
      {
        subtaskId: '02',
        role: 'manager_planning',
        stepId: '02-a',
        stepTitle: 'Plan usage schema',
        provider: 'openai',
        model: 'gpt-test',
        source: 'manual_estimate',
        accuracy: 'estimated',
        tokens: {
          inputTokens: 200,
          outputTokens: 100,
          reasoningTokens: 50,
        },
        pricingSnapshot: {
          inputTokenCostPer1K: 0.002,
          outputTokenCostPer1K: 0.006,
          requestBaseCost: 0.001,
          currency: 'USD',
          source: 'test price card',
          capturedAt: '2026-05-21T12:00:00.000Z',
        },
      },
      {
        subtaskId: '03',
        role: 'verification',
        stepId: '03-a',
        stepTitle: 'Run tests',
        source: 'not_exposed',
        accuracy: 'unknown',
        tokens: {
          inputTokens: 10,
          outputTokens: 5,
        },
      },
    ],
    ...overrides,
  };
}

async function writeLedger(taskDir: string, ledger: TaskUsageLedger): Promise<string> {
  const usagePath = join(taskDir, TOKEN_USAGE_FILE_NAME);
  await writeFile(usagePath, JSON.stringify(ledger, null, 2), 'utf8');
  return usagePath;
}

describe('task usage summary', () => {
  it('summarizes total tokens, cost, and accuracy mix from entries', () => {
    const summary = summarizeTaskUsageLedger(usageLedger(), {
      usagePath: 'task/manager-token-ledger/token-usage.json',
    });

    expect(summary.totals).toMatchObject({
      totalTokens: 515,
      inputTokens: 310,
      outputTokens: 155,
      reasoningTokens: 50,
      cachedInputTokens: 20,
      knownCost: 0.012,
      costUnknownEntries: 1,
      entries: 3,
      actualEntries: 1,
      estimatedEntries: 1,
      unknownEntries: 1,
    });
  });

  it('groups usage by role, subtask, and step', () => {
    const byRole = summarizeTaskUsageLedger(usageLedger(), {
      usagePath: 'token-usage.json',
      by: 'role',
    });
    const bySubtask = summarizeTaskUsageLedger(usageLedger(), {
      usagePath: 'token-usage.json',
      by: 'subtask',
    });
    const byStep = summarizeTaskUsageLedger(usageLedger(), {
      usagePath: 'token-usage.json',
      by: 'step',
    });

    expect(byRole.breakdown?.rows.map((row) => [row.key, row.totalTokens])).toEqual([
      ['manager_planning', 350],
      ['implementation', 150],
      ['verification', 15],
    ]);
    expect(bySubtask.breakdown?.rows.map((row) => row.key)).toEqual(['02', '01', '03']);
    expect(byStep.breakdown?.rows.map((row) => row.key)).toContain('03-a Run tests');
  });

  it('formats a readable report for Manager answers', () => {
    const report = formatTaskUsageSummary(summarizeTaskUsageLedger(usageLedger(), {
      usagePath: 'task/manager-token-ledger/token-usage.json',
      by: 'role',
    }));

    expect(report).toContain('Task: Manager token ledger (manager-token-ledger)');
    expect(report).toContain('tokens: total=515, input=310, output=155, reasoning=50, cached=20');
    expect(report).toContain('cost: USD 0.012000 (1 entries unknown)');
    expect(report).toContain('actual 33.3%, estimated 33.3%, unknown 33.3%');
    expect(report).toContain('Breakdown by role');
  });

  it('includes entry details in the default report for role-step lookups', () => {
    const report = formatTaskUsageSummary(summarizeTaskUsageLedger(usageLedger(), {
      usagePath: 'task/manager-token-ledger/token-usage.json',
    }));

    expect(report).toContain('Entries');
    expect(report).toContain('| 03 | verification | 03-a Run tests | 15 | 10 | 5 | 0 | 0 | unknown | unknown |');
  });

  it('does not present an empty ledger as zero usage', () => {
    const report = formatTaskUsageSummary(summarizeTaskUsageLedger(usageLedger({
      entries: [],
    }), {
      usagePath: 'task/manager-token-ledger/token-usage.json',
    }));

    expect(report).toContain('entries: 0');
    expect(report).toContain('usage: unknown (no token usage entries recorded; this does not mean zero usage)');
    expect(report).not.toContain('tokens: total=0');
  });

  it('uses --task to load a task ledger and print a selected breakdown', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'task-usage-'));

    try {
      const taskDir = join(tempRoot, 'task', 'manager-token-ledger');
      await mkdir(taskDir, { recursive: true });
      await writeLedger(taskDir, usageLedger());

      const output = await summarizeTaskUsageFromCliArgs([
        '--task',
        join('task', 'manager-token-ledger'),
        '--by',
        'subtask',
      ], { cwd: tempRoot });

      expect(output).toContain('Usage file:');
      expect(output).toContain('Breakdown by subtask');
      expect(output).toContain('| 02 | 1 | 350 | 200 | 100 | 50 | 0 | USD 0.002000 | actual 0.0%, estimated 100.0%, unknown 0.0% |');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('selects the latest usage ledger by updatedAt', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'task-usage-'));

    try {
      const olderDir = await mkdtemp(join(tempRoot, 'older-'));
      const newerDir = await mkdtemp(join(tempRoot, 'newer-'));
      await writeLedger(olderDir, usageLedger({
        taskId: 'older',
        taskTitle: 'Older',
        updatedAt: '2026-05-20T12:00:00.000Z',
      }));
      const newerPath = await writeLedger(newerDir, usageLedger({
        taskId: 'newer',
        taskTitle: 'Newer',
        updatedAt: '2026-05-21T12:00:00.000Z',
      }));

      await expect(findLatestTaskUsagePath(tempRoot)).resolves.toBe(newerPath);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports a clear error when token-usage.json is missing', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'task-usage-'));

    try {
      await expect(summarizeTaskUsageFromCliArgs(['--task', '.'], { cwd: tempRoot }))
        .rejects
        .toThrow('Token usage ledger not found');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps token totals when cost cannot be priced', () => {
    const summary = summarizeTaskUsageLedger(usageLedger({
      entries: [
        {
          subtaskId: '01',
          role: 'implementation',
          stepId: '01-a',
          stepTitle: 'No price card',
          accuracy: 'estimated',
          tokens: {
            inputTokens: 10,
            outputTokens: 5,
          },
        },
      ],
    }), {
      usagePath: 'token-usage.json',
    });

    expect(summary.totals.totalTokens).toBe(15);
    expect(summary.totals.knownCost).toBe(0);
    expect(summary.totals.costUnknownEntries).toBe(1);
  });

  it('treats explicit zero-cost usage as known cost', () => {
    const summary = summarizeTaskUsageLedger(usageLedger({
      entries: [
        {
          subtaskId: '01',
          role: 'tooling_api',
          stepId: '01-a',
          stepTitle: 'Local tool call',
          accuracy: 'actual',
          tokens: {
            inputTokens: 10,
            outputTokens: 5,
          },
          cost: {
            totalCost: 0,
            currency: 'USD',
            source: 'provider_billing',
          },
        },
      ],
    }), {
      usagePath: 'token-usage.json',
    });

    expect(summary.totals.totalTokens).toBe(15);
    expect(summary.totals.knownCost).toBe(0);
    expect(summary.totals.costUnknownEntries).toBe(0);
  });
});
