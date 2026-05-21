import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ArtifactName, ManagerConfig, TaskState } from './types.js';

const ARTIFACT_FILES: Record<ArtifactName, string> = {
  'original-task': 'original-task.md',
  'manager-brief': 'manager-brief.md',
  'initial-plan': 'initial-plan.md',
  review: 'review.md',
  'revision-instructions': 'revision-instructions.md',
  'revised-plan': 'revised-plan.md',
  'manager-explanation': 'manager-explanation.md',
  'qa-log': 'qa-log.md',
  'decision-log': 'decision-log.md',
  'implementation-log': 'implementation-log.md',
  'git-pre-status': 'git-pre-status.txt',
  'git-post-status': 'git-post-status.txt',
  'git-pre-diff': 'git-pre-diff.patch',
  'git-post-diff': 'git-post-diff.patch',
  'test-build-log': 'test-build-log.md',
  'final-review': 'final-review.md',
  'final-report': 'final-report.md',
};

export class ArtifactStore {
  readonly baseDir: string;

  constructor(
    readonly managerRoot: string,
    readonly config: ManagerConfig,
  ) {
    this.baseDir = resolve(managerRoot, config.artifactsDir);
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
    await mkdir(this.taskDir(state.taskId), { recursive: true });
    await writeFile(this.statePath(state.taskId), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async loadState(taskIdOrLatest: string): Promise<TaskState> {
    const taskId = taskIdOrLatest === 'latest' ? await this.readLatest() : taskIdOrLatest;
    return JSON.parse(await readFile(this.statePath(taskId), 'utf8')) as TaskState;
  }

  async writeArtifact(state: TaskState, artifact: ArtifactName, content: string): Promise<TaskState> {
    const path = this.artifactPath(state.taskId, artifact);
    await mkdir(this.taskDir(state.taskId), { recursive: true });
    await writeFile(path, content, 'utf8');
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
