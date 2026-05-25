import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDynamicProjects, mergeProjectLists } from './projectRegistry.js';
import type { HeavyWorkflowRoleName, AssistantConfig, ProjectConfig, WorkflowDifficulty, WorkflowRoleProfiles } from './types.js';

export const DEFAULT_VERIFICATION_ALLOWLIST = [
  'npm test',
  'npm run test',
  'npm run build',
  'npm run lint',
  'tsc --noEmit',
  'npx tsc --noEmit',
];

const DEFAULT_WORKFLOW_ROLES: WorkflowRoleProfiles = {
  assistant: 'assistant-elon-ma',
  low: {
    architect: 'codex-architect',
    planReviewer: 'codex-plan-reviewer',
    developer: 'codex-developer',
    finalReviewer: 'codex-final-reviewer',
  },
  medium: {
    architect: 'codex-architect',
    planReviewer: 'claude-plan-reviewer',
    developer: 'codex-developer',
    finalReviewer: 'claude-final-reviewer',
  },
  high: {
    architect: 'claude-architect',
    planReviewer: 'codex-plan-reviewer',
    developer: 'codex-developer',
    finalReviewer: 'claude-final-reviewer',
  },
};

export function getDefaultAssistantRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultConfig(): AssistantConfig {
  return {
    workspace: {
      targetDir: 'E:/GameDeveloping/IReader/my-reader',
    },
    defaultProjectId: 'default',
    projects: [
      {
        id: 'default',
        name: 'Default',
        targetDir: 'E:/GameDeveloping/IReader/my-reader',
        docsDir: 'project-docs/default',
        alwaysRead: [],
      },
    ],
    artifactsDir: 'logs/ai-workflow',
    lark: {
      platform: 'lark',
      appIdEnv: 'LARK_APP_ID',
      appSecretEnv: 'LARK_APP_SECRET',
      allowedOpenIds: [],
      taskMemberOpenIds: [],
      controlChatIds: [],
    },
    maxRevisionRounds: 3,
    workflowRoles: DEFAULT_WORKFLOW_ROLES,
    profiles: {
      'assistant-elon-ma': {
        kind: 'deepseek',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
      'codex-architect': {
        kind: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
        command: 'codex',
      },
      'codex-plan-reviewer': {
        kind: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
        command: 'codex',
      },
      'codex-developer': {
        kind: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
        command: 'codex',
      },
      'codex-final-reviewer': {
        kind: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
        command: 'codex',
      },
      'claude-architect': {
        kind: 'claude',
        model: 'claude-opus-4-7',
        effort: 'high',
        command: 'claude',
      },
      'claude-plan-reviewer': {
        kind: 'claude',
        model: 'claude-opus-4-7',
        effort: 'high',
        command: 'claude',
      },
      'claude-final-reviewer': {
        kind: 'claude',
        model: 'claude-opus-4-7',
        effort: 'high',
        command: 'claude',
      },
    },
    verification: {
      allowlist: DEFAULT_VERIFICATION_ALLOWLIST,
    },
  };
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function normalizeProject(entry: unknown, workspaceTargetDir: string): ProjectConfig | undefined {
  const project = objectValue(entry);
  const id = stringValue(project.id);
  if (!id) return undefined;
  const name = stringValue(project.name) ?? id;
  const taskRecordRoot = stringValue(project.taskRecordRoot);
  return {
    id,
    name,
    targetDir: stringValue(project.targetDir) ?? workspaceTargetDir,
    docsDir: stringValue(project.docsDir) ?? `project-docs/${id}`,
    ...(taskRecordRoot ? { taskRecordRoot } : {}),
    alwaysRead: stringArrayValue(project.alwaysRead) ?? [],
  };
}

function normalizeProjects(rawProjects: unknown, workspaceTargetDir: string, defaultProjectId: string | undefined): ProjectConfig[] {
  const projects = Array.isArray(rawProjects)
    ? rawProjects.flatMap((entry) => {
      const project = normalizeProject(entry, workspaceTargetDir);
      return project ? [project] : [];
    })
    : [];
  if (projects.length > 0) return projects;
  const id = defaultProjectId ?? 'default';
  return [{
    id,
    name: id === 'default' ? 'Default' : id,
    targetDir: workspaceTargetDir,
    docsDir: `project-docs/${id}`,
    alwaysRead: [],
  }];
}

function normalizeWorkflowRoles(raw: unknown, base: WorkflowRoleProfiles): WorkflowRoleProfiles {
  const root = objectValue(raw);
  const difficulties: WorkflowDifficulty[] = ['low', 'medium', 'high'];
  const roleNames: HeavyWorkflowRoleName[] = ['architect', 'planReviewer', 'developer', 'finalReviewer'];
  const normalized = { ...base, assistant: stringValue(root.assistant) ?? base.assistant } as WorkflowRoleProfiles;

  for (const difficulty of difficulties) {
    const rawRoles = objectValue(root[difficulty]);
    normalized[difficulty] = { ...base[difficulty] };
    for (const role of roleNames) {
      normalized[difficulty][role] = stringValue(rawRoles[role]) ?? base[difficulty][role];
    }
  }

  return normalized;
}

export function normalizeConfig(raw: unknown, base = defaultConfig()): AssistantConfig {
  const root = objectValue(raw);
  const workspace = objectValue(root.workspace);
  const workflowRoles = objectValue(root.workflowRoles);
  const profiles = objectValue(root.profiles);
  const verification = objectValue(root.verification);
  const lark = objectValue(root.lark);
  const workspaceTargetDir = stringValue(workspace.targetDir) ?? base.workspace.targetDir;
  const defaultProjectId = stringValue(root.defaultProjectId) ?? base.defaultProjectId ?? 'default';
  const projects = normalizeProjects(root.projects, workspaceTargetDir, defaultProjectId);

  return {
    workspace: {
      targetDir: workspaceTargetDir,
    },
    defaultProjectId,
    projects,
    artifactsDir: stringValue(root.artifactsDir) ?? base.artifactsDir,
    lark: {
      platform: lark.platform === 'feishu' ? 'feishu' : base.lark.platform,
      appIdEnv: stringValue(lark.appIdEnv) ?? base.lark.appIdEnv,
      appSecretEnv: stringValue(lark.appSecretEnv) ?? base.lark.appSecretEnv,
      allowedOpenIds: stringArrayValue(lark.allowedOpenIds) ?? base.lark.allowedOpenIds,
      taskMemberOpenIds: stringArrayValue(lark.taskMemberOpenIds) ?? base.lark.taskMemberOpenIds,
      controlChatIds: stringArrayValue(lark.controlChatIds) ?? base.lark.controlChatIds,
    },
    maxRevisionRounds: numberValue(root.maxRevisionRounds) ?? base.maxRevisionRounds,
    workflowRoles: normalizeWorkflowRoles(workflowRoles, base.workflowRoles),
    profiles: {
      ...base.profiles,
      ...Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, { ...objectValue(profile) }])),
    } as AssistantConfig['profiles'],
    verification: {
      allowlist: stringArrayValue(verification.allowlist) ?? base.verification.allowlist,
    },
  };
}

export async function loadConfig(assistantRoot: string, configPath?: string): Promise<AssistantConfig> {
  const example = await readJsonFile(resolve(assistantRoot, 'assistant.config.example.json'));
  const local = await readJsonFile(configPath ? resolve(assistantRoot, configPath) : resolve(assistantRoot, 'assistant.config.local.json'));
  const config = normalizeConfig(local ?? example);
  const dynamicProjects = await loadDynamicProjects(assistantRoot, config.workspace.targetDir);
  config.projects = mergeProjectLists(config.projects ?? [], dynamicProjects);
  return config;
}
