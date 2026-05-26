import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { sanitizeTextForArtifact } from './textSanitizer.js';
import type { ArtifactName, AssistantConfig, TaskState, WorkflowStatus } from './types.js';

const ARTIFACT_FILES: Record<ArtifactName, string> = {
  'original-task': 'original-task.md',
  'initial-plan': 'initial-plan.md',
  review: 'review.md',
  'revision-instructions': 'revision-instructions.md',
  'plan-rounds-log': 'plan-rounds-log.md',
  'blocker-ledger': 'blocker-ledger.md',
  'revised-plan': 'revised-plan.md',
  'assistant-explanation': 'assistant-explanation.md',
  'qa-log': 'qa-log.md',
  'decision-log': 'decision-log.md',
  'implementation-log': 'implementation-log.md',
  'git-pre-status': 'git-pre-status.txt',
  'git-post-status': 'git-post-status.txt',
  'git-pre-diff': 'git-pre-diff.patch',
  'git-post-diff': 'git-post-diff.patch',
  'followup-git-pre-status': 'followup-git-pre-status.txt',
  'followup-git-pre-diff': 'followup-git-pre-diff.patch',
  'followup-git-post-status': 'followup-git-post-status.txt',
  'followup-git-post-diff': 'followup-git-post-diff.patch',
  'test-build-log': 'test-build-log.md',
  'deferred-issues': 'deferred-issues.md',
  'final-review': 'final-review.md',
  'agent-prompts': 'agent-prompts.md',
  'agent-prompt-preview': 'agent-prompt-preview.md',
  'final-report': 'final-report.md',
};

export class ArtifactStore {
  readonly baseDir: string;

  constructor(
    readonly assistantRoot: string,
    readonly config: AssistantConfig,
  ) {
    this.baseDir = resolve(assistantRoot, config.artifactsDir);
  }

  taskDir(taskId: string): string {
    return join(this.baseDir, 'runs', taskId);
  }

  latestPath(): string {
    return join(this.baseDir, 'latest-task-id.txt');
  }

  statePath(taskId: string): string {
    return join(this.taskDir(taskId), 'state.json');
  }

  artifactPath(taskId: string, artifact: ArtifactName): string {
    return join(this.taskDir(taskId), ARTIFACT_FILES[artifact]);
  }

  async init(): Promise<void> {
    await mkdir(join(this.baseDir, 'runs'), { recursive: true });
  }

  async writeLatest(taskId: string): Promise<void> {
    await this.init();
    await writeFile(this.latestPath(), `${taskId}\n`, 'utf8');
  }

  async readLatest(): Promise<string> {
    return (await readFile(this.latestPath(), 'utf8')).trim();
  }

  async saveState(state: TaskState): Promise<void> {
    const stateToSave = stripInternalPendingPrompt(state);
    await mkdir(this.taskDir(state.taskId), { recursive: true });
    await writeFile(this.statePath(state.taskId), `${JSON.stringify(stateToSave, null, 2)}\n`, 'utf8');
  }

  async loadState(taskIdOrLatest: string): Promise<TaskState> {
    const taskId = taskIdOrLatest === 'latest' ? await this.readLatest() : taskIdOrLatest;
    return JSON.parse(await readFile(this.statePath(taskId), 'utf8')) as TaskState;
  }

  async writeArtifact(state: TaskState, artifact: ArtifactName, content: string): Promise<TaskState> {
    const path = this.artifactPath(state.taskId, artifact);
    await mkdir(this.taskDir(state.taskId), { recursive: true });
    await writeFile(path, sanitizeTextForArtifact(content), 'utf8');
    return {
      ...state,
      updatedAt: new Date().toISOString(),
      artifacts: {
        ...state.artifacts,
        [artifact]: path,
      },
    };
  }

  async appendArtifact(state: TaskState, artifact: ArtifactName, content: string): Promise<TaskState> {
    const previousPath = state.artifacts[artifact];
    const previous = previousPath ? await readFile(previousPath, 'utf8').catch(() => '') : '';
    return this.writeArtifact(state, artifact, previous ? `${previous}\n${content}` : content);
  }

  async readArtifact(state: TaskState, artifact: ArtifactName): Promise<string> {
    const path = state.artifacts[artifact] ?? this.artifactPath(state.taskId, artifact);
    return readFile(path, 'utf8');
  }
}

const INTERNAL_TRANSITION_STATUSES = new Set<WorkflowStatus>([
  'planning_requested',
  'planning',
  'task_artifacts_persisting',
  'execution_queue_ready',
  'implementing',
  'execution_unit_implementing',
  'execution_unit_testing',
  'execution_unit_result_recording',
  'next_execution_unit_or_all_done',
  'implemented',
  'final_reviewing',
  'final_review_routing',
  'task_recording',
]);

function stripInternalPendingPrompt(state: TaskState): TaskState {
  if ((!state.pendingUserPrompt && !state.pendingUserDecision) || !INTERNAL_TRANSITION_STATUSES.has(state.status)) return state;
  console.warn(`Clearing stale pending user direction from internal workflow state ${state.status} for task ${state.taskId}.`);
  const { pendingUserPrompt: _pendingUserPrompt, pendingUserDecision: _pendingUserDecision, ...rest } = state;
  return rest;
}
