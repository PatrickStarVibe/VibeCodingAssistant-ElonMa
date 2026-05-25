import { isAbsolute, resolve } from 'node:path';

import type { AssistantConfig, ProjectConfig } from './types.js';

export function listProjects(config: AssistantConfig): ProjectConfig[] {
  const projects = config.projects ?? [];
  if (projects.length > 0) return projects;
  const id = config.defaultProjectId ?? 'default';
  return [{
    id,
    name: id === 'default' ? 'Default' : id,
    targetDir: config.workspace.targetDir,
    docsDir: `project-docs/${id}`,
    alwaysRead: [],
  }];
}

export function getDefaultProjectId(config: AssistantConfig): string {
  return config.defaultProjectId ?? listProjects(config)[0]?.id ?? 'default';
}

export function findProject(config: AssistantConfig, projectId: string | undefined): ProjectConfig | undefined {
  const projects = listProjects(config);
  if (projectId) return projects.find((project) => project.id === projectId);
  return projects.find((project) => project.id === getDefaultProjectId(config)) ?? projects[0];
}

export function requireProject(config: AssistantConfig, projectId: string | undefined): ProjectConfig {
  const project = findProject(config, projectId);
  if (!project) {
    throw new Error(`Unknown project: ${projectId ?? getDefaultProjectId(config)}`);
  }
  return project;
}

export function resolveProjectDocsDir(assistantRoot: string, project: ProjectConfig): string {
  return isAbsolute(project.docsDir) ? project.docsDir : resolve(assistantRoot, project.docsDir);
}

export function configForProject(config: AssistantConfig, project: ProjectConfig): AssistantConfig {
  return {
    ...config,
    workspace: {
      ...config.workspace,
      targetDir: project.targetDir,
    },
  };
}

export function renderProjectList(config: AssistantConfig, activeProjectId?: string): string {
  const defaultProjectId = getDefaultProjectId(config);
  return listProjects(config)
    .map((project) => {
      const flags = [
        project.id === defaultProjectId ? '默认' : undefined,
        project.id === activeProjectId ? '当前' : undefined,
      ].filter(Boolean).join(', ');
      return [
        `- ${project.id}: ${project.name}${flags ? ` (${flags})` : ''}`,
        `  目标工作区：${project.targetDir}`,
        `  文档目录：${project.docsDir}`,
        `  task record：${project.taskRecordRoot ?? '<targetDir>/task'}`,
      ].join('\n');
    })
    .join('\n');
}
