import { isAbsolute, resolve } from 'node:path';

import type { ManagerConfig, ProjectConfig } from './types.js';

export function listProjects(config: ManagerConfig): ProjectConfig[] {
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

export function getDefaultProjectId(config: ManagerConfig): string {
  return config.defaultProjectId ?? listProjects(config)[0]?.id ?? 'default';
}

export function findProject(config: ManagerConfig, projectId: string | undefined): ProjectConfig | undefined {
  const projects = listProjects(config);
  if (projectId) return projects.find((project) => project.id === projectId);
  return projects.find((project) => project.id === getDefaultProjectId(config)) ?? projects[0];
}

export function requireProject(config: ManagerConfig, projectId: string | undefined): ProjectConfig {
  const project = findProject(config, projectId);
  if (!project) {
    throw new Error(`Unknown project: ${projectId ?? getDefaultProjectId(config)}`);
  }
  return project;
}

export function resolveProjectDocsDir(managerRoot: string, project: ProjectConfig): string {
  return isAbsolute(project.docsDir) ? project.docsDir : resolve(managerRoot, project.docsDir);
}

export function configForProject(config: ManagerConfig, project: ProjectConfig): ManagerConfig {
  return {
    ...config,
    workspace: {
      ...config.workspace,
      targetDir: project.targetDir,
    },
  };
}

export function renderProjectList(config: ManagerConfig, activeProjectId?: string): string {
  const defaultProjectId = getDefaultProjectId(config);
  return listProjects(config)
    .map((project) => {
      const flags = [
        project.id === defaultProjectId ? 'default' : undefined,
        project.id === activeProjectId ? 'active' : undefined,
      ].filter(Boolean).join(', ');
      return [
        `- ${project.id}: ${project.name}${flags ? ` (${flags})` : ''}`,
        `  target: ${project.targetDir}`,
        `  docs: ${project.docsDir}`,
        `  task records: ${project.taskRecordRoot ?? '<targetDir>/task'}`,
      ].join('\n');
    })
    .join('\n');
}
