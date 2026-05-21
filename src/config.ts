import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ManagerConfig, ProjectConfig, RoleName, WorkflowDifficulty, WorkflowRoleName, WorkflowRoleProfiles } from './types.js';

export const DEFAULT_VERIFICATION_ALLOWLIST = [
  'npm test',
  'npm run test',
  'npm run build',
  'npm run lint',
  'tsc --noEmit',
  'npx tsc --noEmit',
];

const DEFAULT_ROLES: Record<RoleName, string> = {
  manager: 'deepseek-manager',
  planner: 'codex-planner',
  reviewer: 'claude-reviewer',
  implementer: 'codex-implementer',
  finalReviewer: 'claude-final-reviewer',
};

const DEFAULT_WORKFLOW_ROLES: WorkflowRoleProfiles = {
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
    planReviewer: 'claude-plan-reviewer',
    developer: 'codex-developer',
    finalReviewer: 'claude-final-reviewer',
  },
};

export function getDefaultManagerRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultConfig(): ManagerConfig {
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
      watchIntervalSeconds: 10,
    },
    maxRevisionRounds: 3,
    roles: DEFAULT_ROLES,
    workflowRoles: DEFAULT_WORKFLOW_ROLES,
    profiles: {
      'deepseek-manager': {
        kind: 'deepseek',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
      'codex-planner': {
        kind: 'codex',
        command: 'codex',
      },
      'codex-architect': {
        kind: 'codex',
        command: 'codex',
      },
      'codex-plan-reviewer': {
        kind: 'codex',
        command: 'codex',
      },
      'codex-implementer': {
        kind: 'codex',
        command: 'codex',
      },
      'codex-developer': {
        kind: 'codex',
        command: 'codex',
      },
      'codex-final-reviewer': {
        kind: 'codex',
        command: 'codex',
      },
      'claude-reviewer': {
        kind: 'claude',
        command: 'claude',
      },
      'claude-architect': {
        kind: 'claude',
        command: 'claude',
      },
      'claude-plan-reviewer': {
        kind: 'claude',
        command: 'claude',
      },
      'claude-final-reviewer': {
        kind: 'claude',
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
  const roleNames: WorkflowRoleName[] = ['architect', 'planReviewer', 'developer', 'finalReviewer'];
  const normalized = { ...base } as WorkflowRoleProfiles;

  for (const difficulty of difficulties) {
    const rawRoles = objectValue(root[difficulty]);
    normalized[difficulty] = { ...base[difficulty] };
    for (const role of roleNames) {
      normalized[difficulty][role] = stringValue(rawRoles[role]) ?? base[difficulty][role];
    }
  }

  return normalized;
}

export function normalizeConfig(raw: unknown, base = defaultConfig()): ManagerConfig {
  const root = objectValue(raw);
  const workspace = objectValue(root.workspace);
  const roles = objectValue(root.roles);
  const workflowRoles = objectValue(root.workflowRoles);
  const profiles = objectValue(root.profiles);
  const verification = objectValue(root.verification);
  const lark = objectValue(root.lark);
  const larkPairingCode = stringValue(lark.pairingCode);
  const roleNames = Object.keys(base.roles) as RoleName[];
  const normalizedRoles = { ...base.roles };
  const workspaceTargetDir = stringValue(workspace.targetDir) ?? base.workspace.targetDir;
  const defaultProjectId = stringValue(root.defaultProjectId) ?? base.defaultProjectId ?? 'default';
  const projects = normalizeProjects(root.projects, workspaceTargetDir, defaultProjectId);

  for (const role of roleNames) {
    normalizedRoles[role] = stringValue(roles[role]) ?? base.roles[role];
  }

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
      watchIntervalSeconds: numberValue(lark.watchIntervalSeconds) ?? base.lark.watchIntervalSeconds,
      ...(larkPairingCode ? { pairingCode: larkPairingCode } : {}),
    },
    maxRevisionRounds: numberValue(root.maxRevisionRounds) ?? base.maxRevisionRounds,
    roles: normalizedRoles,
    workflowRoles: normalizeWorkflowRoles(workflowRoles, base.workflowRoles),
    profiles: {
      ...base.profiles,
      ...Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, { ...objectValue(profile) }])),
    } as ManagerConfig['profiles'],
    verification: {
      allowlist: stringArrayValue(verification.allowlist) ?? base.verification.allowlist,
    },
  };
}

export async function loadConfig(managerRoot: string, configPath?: string): Promise<ManagerConfig> {
  const example = await readJsonFile(resolve(managerRoot, 'manager.config.example.json'));
  const local = await readJsonFile(configPath ? resolve(managerRoot, configPath) : resolve(managerRoot, 'manager.config.local.json'));
  return normalizeConfig(local ?? example);
}
