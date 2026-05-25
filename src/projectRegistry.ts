import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, normalize, resolve } from 'node:path';

import type { AssistantConfig, ProjectConfig } from './types.js';

export const DYNAMIC_PROJECTS_FILE = 'assistant.projects.local.json';

export interface AddProjectInput {
  id?: string;
  name?: string;
  targetDir: string;
  docsDir?: string;
  taskRecordRoot?: string;
}

export interface AddProjectResult {
  project: ProjectConfig;
  created: boolean;
  registryPath: string;
}

export async function addProjectToRegistry(
  assistantRoot: string,
  config: AssistantConfig,
  input: AddProjectInput,
): Promise<AddProjectResult> {
  const targetDir = await normalizeExistingDirectory(input.targetDir);
  const dynamicProjects = await loadDynamicProjects(assistantRoot, config.workspace.targetDir);
  const knownProjects = mergeProjectLists(config.projects ?? [], dynamicProjects);
  const existingByPath = knownProjects.find((project) => sameTargetDir(project.targetDir, targetDir));
  const registryPath = resolve(assistantRoot, DYNAMIC_PROJECTS_FILE);

  if (existingByPath) {
    upsertConfigProject(config, existingByPath);
    return { project: existingByPath, created: false, registryPath };
  }

  const explicitId = input.id ? normalizeProjectId(input.id) : undefined;
  if (input.id && !explicitId) {
    throw new Error('项目 id 至少需要包含一个英文字母或数字。');
  }

  const projectId = explicitId ?? nextAvailableProjectId(inferProjectId(targetDir), knownProjects);
  const existingById = knownProjects.find((project) => project.id === projectId);
  if (existingById && !sameTargetDir(existingById.targetDir, targetDir)) {
    throw new Error(`项目 id ${projectId} 已被 ${existingById.name} 使用；请换一个 id。`);
  }

  const taskRecordRoot = cleanString(input.taskRecordRoot);
  const project: ProjectConfig = {
    id: projectId,
    name: cleanString(input.name) ?? inferProjectName(targetDir, projectId),
    targetDir,
    docsDir: cleanString(input.docsDir) ?? `project-docs/${projectId}`,
    ...(taskRecordRoot ? { taskRecordRoot } : {}),
    alwaysRead: [],
  };

  await writeDynamicProjects(assistantRoot, mergeProjectLists(dynamicProjects, [project]));
  upsertConfigProject(config, project);
  return { project, created: true, registryPath };
}

export async function loadDynamicProjects(assistantRoot: string, workspaceTargetDir: string): Promise<ProjectConfig[]> {
  const raw = await readJsonFile(resolve(assistantRoot, DYNAMIC_PROJECTS_FILE));
  return normalizeProjectRegistry(raw, workspaceTargetDir);
}

export function normalizeProjectRegistry(raw: unknown, workspaceTargetDir: string): ProjectConfig[] {
  const root = objectValue(raw);
  const projects = Array.isArray(root.projects) ? root.projects : [];
  return projects.flatMap((entry) => {
    const project = normalizeProject(entry, workspaceTargetDir);
    return project ? [project] : [];
  });
}

export function mergeProjectLists(primary: ProjectConfig[], secondary: ProjectConfig[]): ProjectConfig[] {
  const merged = [...primary];
  for (const project of secondary) {
    if (merged.some((existing) => existing.id === project.id)) continue;
    if (merged.some((existing) => sameTargetDir(existing.targetDir, project.targetDir))) continue;
    merged.push(project);
  }
  return merged;
}

export function comparableTargetDir(path: string): string {
  const normalized = normalize(resolve(path)).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

async function normalizeExistingDirectory(input: string): Promise<string> {
  const cleaned = unwrapQuotes(input.trim());
  if (!cleaned) throw new Error('请提供项目位置 targetDir。');
  const targetDir = normalize(resolve(cleaned));
  const targetStat = await stat(targetDir).catch(() => undefined);
  if (!targetStat?.isDirectory()) {
    throw new Error(`项目位置不存在或不是文件夹：${targetDir}`);
  }
  return targetDir;
}

async function writeDynamicProjects(assistantRoot: string, projects: ProjectConfig[]): Promise<void> {
  const path = resolve(assistantRoot, DYNAMIC_PROJECTS_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ projects }, null, 2)}\n`, 'utf8');
}

function upsertConfigProject(config: AssistantConfig, project: ProjectConfig): void {
  const projects = config.projects ?? [];
  if (!config.projects) config.projects = projects;
  const index = projects.findIndex((existing) => existing.id === project.id);
  if (index >= 0) {
    projects[index] = project;
  } else {
    projects.push(project);
  }
}

function nextAvailableProjectId(baseId: string, projects: ProjectConfig[]): string {
  let candidate = baseId;
  let suffix = 2;
  const ids = new Set(projects.map((project) => project.id));
  while (ids.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function inferProjectId(targetDir: string): string {
  return normalizeProjectId(basename(targetDir)) ?? 'project';
}

function inferProjectName(targetDir: string, projectId: string): string {
  return basename(targetDir).trim() || projectId;
}

function normalizeProject(entry: unknown, workspaceTargetDir: string): ProjectConfig | undefined {
  const raw = objectValue(entry);
  const id = cleanString(raw.id);
  if (!id) return undefined;
  const taskRecordRoot = cleanString(raw.taskRecordRoot);
  return {
    id,
    name: cleanString(raw.name) ?? id,
    targetDir: cleanString(raw.targetDir) ?? workspaceTargetDir,
    docsDir: cleanString(raw.docsDir) ?? `project-docs/${id}`,
    ...(taskRecordRoot ? { taskRecordRoot } : {}),
    alwaysRead: stringArrayValue(raw.alwaysRead) ?? [],
  };
}

function sameTargetDir(left: string, right: string): boolean {
  return comparableTargetDir(left) === comparableTargetDir(right);
}

function normalizeProjectId(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return normalized || undefined;
}

function unwrapQuotes(value: string): string {
  return value.replace(/^["'](.+)["']$/, '$1');
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
