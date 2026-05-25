import type { WorkflowDifficulty } from './types.js';

export const WORKFLOW_DIFFICULTIES: WorkflowDifficulty[] = ['low', 'medium', 'high', 'extra-high'];

export function normalizeWorkflowDifficulty(value: string): WorkflowDifficulty | undefined {
  const normalized = value.trim().toLocaleLowerCase().replace(/[\s_]+/g, '-');
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'extra-high') {
    return normalized;
  }
  return undefined;
}
