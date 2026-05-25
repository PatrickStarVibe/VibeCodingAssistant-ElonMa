import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDynamicProjects, mergeProjectLists } from './projectRegistry.js';
import type {
  AgentProfileConfig,
  HeavyWorkflowRoleName,
  AssistantConfig,
  ProjectConfig,
  WorkflowDifficulty,
  WorkflowRoleProfiles,
} from './types.js';

export const DEFAULT_VERIFICATION_ALLOWLIST = [
  'npm test',
  'npm run test',
  'npm run build',
  'npm run lint',
  'tsc --noEmit',
  'npx tsc --noEmit',
];

const DEFAULT_WORKFLOW_ROLES: WorkflowRoleProfiles = {
  assistant: 'assistant-api',
  low: {
    architect: 'architect-agent',
    planReviewer: 'plan-reviewer-agent',
    developer: 'developer-agent',
    finalReviewer: 'final-reviewer-agent',
  },
  medium: {
    architect: 'architect-agent',
    planReviewer: 'plan-reviewer-agent',
    developer: 'developer-agent',
    finalReviewer: 'final-reviewer-agent',
  },
  high: {
    architect: 'architect-agent',
    planReviewer: 'plan-reviewer-agent',
    developer: 'developer-agent',
    finalReviewer: 'final-reviewer-agent',
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
      'assistant-api': {
        kind: 'openai-compatible',
        apiKeyEnv: 'ASSISTANT_API_KEY',
      },
      'architect-agent': {
        kind: 'command',
      },
      'plan-reviewer-agent': {
        kind: 'command',
      },
      'developer-agent': {
        kind: 'command',
      },
      'final-reviewer-agent': {
        kind: 'command',
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

function profileKind(rawProfile: Record<string, unknown>, baseProfile?: AgentProfileConfig): string {
  return stringValue(rawProfile.kind)
    ?? baseProfile?.kind
    ?? (stringValue(rawProfile.command) ? 'command' : 'openai-compatible');
}

function applyLegacyDeepSeekCompatibility(profile: AgentProfileConfig): AgentProfileConfig {
  if (profile.kind !== 'deepseek' && profile.provider !== 'deepseek') return profile;
  return {
    ...profile,
    kind: 'openai-compatible',
    provider: profile.provider ?? 'deepseek',
    model: profile.model ?? 'deepseek-v4-flash',
    baseUrl: profile.baseUrl ?? 'https://api.deepseek.com/v1',
    apiKeyEnv: profile.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
  };
}

function normalizeProfile(entry: unknown, baseProfile?: AgentProfileConfig): AgentProfileConfig {
  const rawProfile = objectValue(entry);
  const kind = profileKind(rawProfile, baseProfile);
  const provider = stringValue(rawProfile.provider) ?? baseProfile?.provider;
  const model = stringValue(rawProfile.model) ?? baseProfile?.model;
  const effort = stringValue(rawProfile.effort) ?? baseProfile?.effort;
  const baseUrl = stringValue(rawProfile.baseUrl) ?? baseProfile?.baseUrl;
  const apiKeyEnv = stringValue(rawProfile.apiKeyEnv) ?? baseProfile?.apiKeyEnv;
  const command = stringValue(rawProfile.command) ?? baseProfile?.command;
  return applyLegacyDeepSeekCompatibility({
    kind,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(command ? { command } : {}),
  });
}

function normalizeProfiles(rawProfiles: unknown, baseProfiles: AssistantConfig['profiles']): AssistantConfig['profiles'] {
  const profiles = objectValue(rawProfiles);
  const normalized: AssistantConfig['profiles'] = Object.fromEntries(
    Object.entries(baseProfiles).map(([name, profile]) => [name, normalizeProfile(profile)]),
  );

  for (const [name, profile] of Object.entries(profiles)) {
    normalized[name] = normalizeProfile(profile, normalized[name]);
  }

  return normalized;
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
    profiles: normalizeProfiles(profiles, base.profiles),
    verification: {
      allowlist: stringArrayValue(verification.allowlist) ?? base.verification.allowlist,
    },
  };
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvLocal(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const exportPrefix = 'export ';
    const assignment = line.startsWith(exportPrefix) ? line.slice(exportPrefix.length).trim() : line;
    const equalsIndex = assignment.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquoteEnvValue(assignment.slice(equalsIndex + 1));
  }
  return values;
}

export async function loadLocalEnv(assistantRoot: string): Promise<void> {
  const content = await readFile(resolve(assistantRoot, '.env.local'), 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!content) return;

  for (const [key, value] of Object.entries(parseEnvLocal(content))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export async function loadConfig(assistantRoot: string, configPath?: string): Promise<AssistantConfig> {
  await loadLocalEnv(assistantRoot);
  const example = await readJsonFile(resolve(assistantRoot, 'assistant.config.example.json'));
  const local = await readJsonFile(configPath ? resolve(assistantRoot, configPath) : resolve(assistantRoot, 'assistant.config.local.json'));
  const config = normalizeConfig(local ?? example);
  const dynamicProjects = await loadDynamicProjects(assistantRoot, config.workspace.targetDir);
  config.projects = mergeProjectLists(config.projects ?? [], dynamicProjects);
  return config;
}
