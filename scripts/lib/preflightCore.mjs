/**
 * Shared helpers for VibeCodingAssistant-ElonMa distribution preflight, setup, and repo hygiene scripts.
 * Exports pure ESM utilities for config loading, env parsing, profile validation,
 * executable probing, git status, and JSON/human output coordination.
 * Author: VibeCodingAssistant-ElonMa distribution tooling
 */

import { accessSync, existsSync, readFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, delimiter, extname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const WORKFLOW_DIFFICULTIES = ['low', 'medium', 'high', 'extra-high'];
const HEAVY_WORKFLOW_ROLES = ['architect', 'planReviewer', 'developer', 'finalReviewer'];
const COMMAND_PROFILE_KINDS = new Set(['command', 'codex', 'claude']);
const DEFAULT_VERIFICATION_ALLOWLIST = [
  'npm test',
  'npm run test',
  'npm run build',
  'npm run lint',
  'tsc --noEmit',
  'npx tsc --noEmit',
];

const EMPTY_BASE_CONFIG = {
  workspace: {},
  defaultProjectId: undefined,
  projects: [],
  artifactsDir: 'logs/ai-workflow',
  lark: undefined,
  maxRevisionRounds: 3,
  workflowRoles: {
    assistant: undefined,
    low: {},
    medium: {},
    high: {},
    'extra-high': {},
  },
  profiles: {},
  verification: {
    allowlist: DEFAULT_VERIFICATION_ALLOWLIST,
  },
};

function objectValue(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringArrayValue(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function unquoteEnvValue(value) {
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

/**
 * Parse a dotenv-style file with the same semantics as src/config.ts::parseEnvLocal.
 * Missing files return exists=false; invalid assignment keys are skipped silently.
 */
export async function parseEnvFile(path) {
  const vars = new Map();
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { vars, exists: false };
    }
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const exportPrefix = 'export ';
    const assignment = line.startsWith(exportPrefix) ? line.slice(exportPrefix.length).trim() : line;
    const equalsIndex = assignment.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    vars.set(key, unquoteEnvValue(assignment.slice(equalsIndex + 1)));
  }

  return { vars, exists: true };
}

function profileKind(rawProfile, baseProfile) {
  return stringValue(rawProfile.kind)
    ?? baseProfile?.kind
    ?? (stringValue(rawProfile.command) ? 'command' : 'openai-compatible');
}

function applyLegacyDeepSeekCompatibility(profile) {
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

function normalizeProfile(entry, baseProfile) {
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

function normalizeProfiles(rawProfiles, baseProfiles) {
  const profiles = objectValue(rawProfiles);
  const normalized = Object.fromEntries(
    Object.entries(baseProfiles).map(([name, profile]) => [name, normalizeProfile(profile)]),
  );

  for (const [name, profile] of Object.entries(profiles)) {
    normalized[name] = normalizeProfile(profile, normalized[name]);
  }

  return normalized;
}

function normalizeProject(entry) {
  const project = objectValue(entry);
  const id = stringValue(project.id);
  if (!id) return undefined;
  const name = stringValue(project.name) ?? id;
  const taskRecordRoot = stringValue(project.taskRecordRoot);
  const targetDir = stringValue(project.targetDir);
  return {
    id,
    name,
    ...(targetDir ? { targetDir } : {}),
    docsDir: stringValue(project.docsDir) ?? `project-docs/${id}`,
    ...(taskRecordRoot ? { taskRecordRoot } : {}),
    alwaysRead: stringArrayValue(project.alwaysRead) ?? [],
  };
}

function normalizeProjects(rawProjects) {
  const projects = Array.isArray(rawProjects)
    ? rawProjects.flatMap((entry) => {
      const project = normalizeProject(entry);
      return project ? [project] : [];
    })
    : [];
  return projects;
}

function normalizeWorkflowRoles(raw, base) {
  const root = objectValue(raw);
  const normalized = {
    ...base,
    assistant: stringValue(root.assistant) ?? base.assistant,
  };
  const hasRawExtraHigh = Object.prototype.hasOwnProperty.call(root, 'extra-high');

  for (const difficulty of WORKFLOW_DIFFICULTIES) {
    const rawRoles = objectValue(root[difficulty]);
    const baseRoles = difficulty === 'extra-high' && !hasRawExtraHigh ? normalized.high : base[difficulty];
    normalized[difficulty] = { ...baseRoles };
    for (const role of HEAVY_WORKFLOW_ROLES) {
      const nextValue = stringValue(rawRoles[role]) ?? baseRoles?.[role];
      if (nextValue) normalized[difficulty][role] = nextValue;
    }
  }

  return normalized;
}

function normalizeConfig(raw, base = EMPTY_BASE_CONFIG) {
  const root = objectValue(raw);
  const workspace = objectValue(root.workspace);
  const verification = objectValue(root.verification);
  const hasRawLark = Object.prototype.hasOwnProperty.call(root, 'lark');
  const lark = objectValue(root.lark);
  const workspaceTargetDir = stringValue(workspace.targetDir) ?? base.workspace.targetDir;
  const defaultProjectId = stringValue(root.defaultProjectId) ?? base.defaultProjectId;
  const projects = normalizeProjects(root.projects);
  const normalizedLark = hasRawLark || base.lark
    ? {
      platform: lark.platform === 'feishu' ? 'feishu' : base.lark?.platform ?? 'lark',
      appIdEnv: stringValue(lark.appIdEnv) ?? base.lark?.appIdEnv ?? 'LARK_APP_ID',
      appSecretEnv: stringValue(lark.appSecretEnv) ?? base.lark?.appSecretEnv ?? 'LARK_APP_SECRET',
      allowedOpenIds: stringArrayValue(lark.allowedOpenIds) ?? base.lark?.allowedOpenIds ?? [],
      taskMemberOpenIds: stringArrayValue(lark.taskMemberOpenIds) ?? base.lark?.taskMemberOpenIds ?? [],
      controlChatIds: stringArrayValue(lark.controlChatIds) ?? base.lark?.controlChatIds ?? [],
    }
    : undefined;

  return {
    workspace: {
      ...(workspaceTargetDir ? { targetDir: workspaceTargetDir } : {}),
    },
    ...(defaultProjectId ? { defaultProjectId } : {}),
    projects,
    artifactsDir: stringValue(root.artifactsDir) ?? base.artifactsDir,
    ...(normalizedLark ? { lark: normalizedLark } : {}),
    maxRevisionRounds: numberValue(root.maxRevisionRounds) ?? base.maxRevisionRounds,
    workflowRoles: normalizeWorkflowRoles(root.workflowRoles, base.workflowRoles),
    profiles: normalizeProfiles(root.profiles, base.profiles),
    verification: {
      allowlist: stringArrayValue(verification.allowlist) ?? base.verification.allowlist,
    },
  };
}

function captureRawProfileMeta(raw) {
  const profiles = objectValue(objectValue(raw).profiles);
  const meta = {};
  for (const [name, profile] of Object.entries(profiles)) {
    const rawProfile = objectValue(profile);
    const rawNpmScript = stringValue(rawProfile.npmScript);
    const rawKind = stringValue(rawProfile.kind);
    meta[name] = {
      ...(rawNpmScript ? { rawNpmScript } : {}),
      rawHasCommand: Object.prototype.hasOwnProperty.call(rawProfile, 'command'),
      ...(rawKind ? { rawKind } : {}),
    };
  }
  return meta;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Load assistant config without importing runtime defaults. The default behavior refuses
 * example-only fallback because example config is not launchable.
 */
export async function loadConfig({ explicitPath, cwd = process.cwd(), allowExampleFallback = false } = {}) {
  const root = resolve(cwd);
  const localPath = resolve(root, 'assistant.config.local.json');
  const examplePath = resolve(root, 'assistant.config.example.json');
  const warnings = [];

  let source;
  let sourceKind;
  let raw;

  if (explicitPath) {
    source = resolve(root, explicitPath);
    try {
      raw = await readJson(source);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw Object.assign(new Error(`config-source: not found: ${source}`), {
          code: 'CONFIG_SOURCE_MISSING',
          source,
          sourceKind: 'explicit',
        });
      }
      throw error;
    }
    sourceKind = 'explicit';
    if (source === examplePath) {
      warnings.push('assistant.config.example.json was loaded explicitly; example config is usually not launchable.');
    }
  } else if (existsSync(localPath)) {
    source = localPath;
    raw = await readJson(source);
    sourceKind = 'local';
  } else if (existsSync(examplePath)) {
    if (!allowExampleFallback) {
      throw Object.assign(
        new Error("config-source: no launchable config - only assistant.config.example.json found. Run 'npm run assistant:setup'."),
        {
          code: 'CONFIG_SOURCE_EXAMPLE_ONLY',
          source: examplePath,
          sourceKind: 'example',
        },
      );
    }
    source = examplePath;
    raw = await readJson(source);
    sourceKind = 'example';
    warnings.push('assistant.config.example.json was used as fallback; create assistant.config.local.json before launch.');
  } else {
    throw Object.assign(
      new Error('config-source: no assistant.config.local.json or assistant.config.example.json found.'),
      {
        code: 'CONFIG_SOURCE_MISSING',
        source: undefined,
        sourceKind: 'missing',
      },
    );
  }

  return {
    rawProfileMeta: captureRawProfileMeta(raw),
    normalized: normalizeConfig(raw),
    source,
    sourceKind,
    warnings,
  };
}

/**
 * Runtime precedence: process.env wins over parsed env-file values, including empty strings.
 */
export function effectiveEnvValue(name, parsedEnvFile) {
  if (process.env[name] !== undefined) {
    return { value: process.env[name], source: 'process.env' };
  }
  if (parsedEnvFile?.vars?.has(name)) {
    return { value: parsedEnvFile.vars.get(name), source: 'env-file' };
  }
  return { value: undefined, source: 'missing' };
}

function isCommandBackedProfile(profile) {
  return COMMAND_PROFILE_KINDS.has(String(profile?.kind ?? '').trim().toLowerCase())
    || Boolean(profile?.command?.trim());
}

function isOpenAICompatibleProfile(profile) {
  return !isCommandBackedProfile(profile)
    && Boolean(profile?.model?.trim())
    && Boolean(profile?.baseUrl?.trim())
    && Boolean(profile?.apiKeyEnv?.trim());
}

function referencedProfileNames(normalized) {
  const names = new Set();
  const assistant = normalized?.workflowRoles?.assistant;
  if (assistant) names.add(assistant);
  for (const difficulty of WORKFLOW_DIFFICULTIES) {
    const roles = normalized?.workflowRoles?.[difficulty] ?? {};
    for (const role of HEAVY_WORKFLOW_ROLES) {
      if (roles[role]) names.add(roles[role]);
    }
  }
  return names;
}

/**
 * Collect required env var names from the resolved config. Values are never read here.
 */
export function collectRequiredEnvNames(normalized) {
  const apiKeyEnvs = [];
  const byProfile = {};
  const addApiKeyEnv = (profileName) => {
    if (!profileName) return;
    const profile = normalized?.profiles?.[profileName];
    if (!profile || isCommandBackedProfile(profile)) return;
    const envName = profile.apiKeyEnv?.trim();
    if (!envName) return;
    if (!apiKeyEnvs.includes(envName)) apiKeyEnvs.push(envName);
    byProfile[profileName] = envName;
  };

  addApiKeyEnv(normalized?.workflowRoles?.assistant);
  for (const difficulty of WORKFLOW_DIFFICULTIES) {
    const roles = normalized?.workflowRoles?.[difficulty] ?? {};
    for (const role of HEAVY_WORKFLOW_ROLES) {
      addApiKeyEnv(roles[role]);
    }
  }

  const larkEnvs = [];
  const appIdEnv = normalized?.lark?.appIdEnv?.trim();
  const appSecretEnv = normalized?.lark?.appSecretEnv?.trim();
  if (appIdEnv) larkEnvs.push(appIdEnv);
  if (appSecretEnv && !larkEnvs.includes(appSecretEnv)) larkEnvs.push(appSecretEnv);

  return { apiKeyEnvs, larkEnvs, byProfile };
}

export function isPlaceholderValue(value) {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const normalized = trimmed.toLowerCase();
  return normalized === 'xxx'
    || normalized === 'replace_me'
    || normalized === 'cli_xxx'
    || normalized === 'your_path_here'
    || normalized === 'ou_your_open_id_here'
    || normalized.includes('/path/to/your/')
    || normalized.includes('\\path\\to\\your\\')
    || /^your(?:[_-].*)?here$/.test(normalized)
    || /^your[_-].*[_-]here$/.test(normalized)
    || /^replace[_-]?me$/.test(normalized);
}

export function validateProfiles(normalized) {
  const errors = [];
  const warnings = [];
  const profiles = normalized?.profiles ?? {};
  const assistantName = normalized?.workflowRoles?.assistant;
  const assistantProfile = assistantName ? profiles[assistantName] : undefined;

  if (!assistantName) {
    errors.push('workflowRoles.assistant is missing.');
  } else if (!assistantProfile) {
    errors.push(`workflowRoles.assistant references missing profile "${assistantName}".`);
  } else if (!isOpenAICompatibleProfile(assistantProfile)) {
    if (isCommandBackedProfile(assistantProfile)) {
      errors.push(`Assistant profile "${assistantName}" is command-backed, but assistant chat requires an OpenAI-compatible API profile.`);
    } else {
      errors.push(`Assistant profile "${assistantName}" must define model, baseUrl, and apiKeyEnv.`);
    }
  }

  for (const difficulty of WORKFLOW_DIFFICULTIES) {
    const roles = normalized?.workflowRoles?.[difficulty] ?? {};
    for (const role of HEAVY_WORKFLOW_ROLES) {
      const profileName = roles[role];
      if (!profileName) {
        errors.push(`workflowRoles.${difficulty}.${role} is missing.`);
        continue;
      }
      const profile = profiles[profileName];
      if (!profile) {
        errors.push(`workflowRoles.${difficulty}.${role} references missing profile "${profileName}".`);
        continue;
      }
      if (!isCommandBackedProfile(profile)) {
        errors.push(`workflowRoles.${difficulty}.${role} uses profile "${profileName}", but workflow agents require a command-backed profile.`);
      }
    }
  }

  return { errors, warnings };
}

export function validateWorkspacePaths(normalized) {
  const errors = [];
  const workspaceTargetDir = normalized?.workspace?.targetDir;
  if (isPlaceholderValue(workspaceTargetDir)) {
    errors.push('workspace.targetDir is missing, blank, or still a placeholder.');
  }

  const projects = Array.isArray(normalized?.projects) ? normalized.projects : [];
  for (const project of projects) {
    const id = project?.id ?? '<missing-id>';
    if (isPlaceholderValue(project?.targetDir)) {
      errors.push(`projects.${id}.targetDir is missing, blank, or still a placeholder.`);
    }
  }

  const defaultProjectId = normalized?.defaultProjectId;
  if (defaultProjectId && !projects.some((project) => project?.id === defaultProjectId)) {
    errors.push(`defaultProjectId "${defaultProjectId}" does not match any projects[].id.`);
  }

  return { errors };
}

export function validateLarkOpenIds(normalized) {
  const errors = [];
  const warnings = [];
  const lark = normalized?.lark;
  if (!lark) return { errors, warnings };

  const allowedOpenIds = Array.isArray(lark.allowedOpenIds) ? lark.allowedOpenIds : [];
  if (allowedOpenIds.length === 0) {
    errors.push('lark.allowedOpenIds is empty; configure at least one allowed user open_id.');
  }
  for (const [index, openId] of allowedOpenIds.entries()) {
    if (isPlaceholderValue(openId)) {
      errors.push(`lark.allowedOpenIds[${index}] is missing, blank, or still a placeholder.`);
    }
  }

  return { errors, warnings };
}

function stripCommandQuotes(command) {
  const trimmed = command.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isPathLikeCommand(command) {
  return /[\\/]/.test(command)
    || /^[A-Za-z]:/.test(command)
    || /^\\\\/.test(command)
    || command === '.'
    || command === '..'
    || command.startsWith(`.${'/'}`)
    || command.startsWith(`.${'\\'}`)
    || command.startsWith(`..${'/'}`)
    || command.startsWith(`..${'\\'}`);
}

function candidatePathExtensions(command) {
  if (process.platform !== 'win32') return [command];
  if (extname(command)) return [command];
  const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  return [command, ...pathExt.map((extension) => `${command}${extension.toLowerCase()}`), ...pathExt.map((extension) => `${command}${extension.toUpperCase()}`)];
}

function fileIsExecutable(path) {
  try {
    accessSync(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathLikeCommand(command) {
  const path = isAbsolute(command) ? command : resolve(process.cwd(), command);
  const candidates = candidatePathExtensions(path);
  return candidates.find((candidate) => fileIsExecutable(candidate));
}

function resolveBareCommand(command) {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(lookupCommand, [command], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

export function probeExecutable(command) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { ok: false, mode: 'invalid', detail: 'command is empty.' };
  }
  const cleaned = stripCommandQuotes(command);
  if (cleaned.length === 0) {
    return { ok: false, mode: 'invalid', detail: 'command is empty.' };
  }

  if (isPathLikeCommand(cleaned)) {
    const resolved = resolvePathLikeCommand(cleaned);
    return resolved
      ? { ok: true, mode: 'path', detail: `found: ${resolved}` }
      : { ok: false, mode: 'path', detail: `not found or not executable: ${cleaned}` };
  }

  const resolved = resolveBareCommand(cleaned);
  return resolved
    ? { ok: true, mode: 'path-search', detail: `found: ${resolved}` }
    : { ok: false, mode: 'path-search', detail: `not found in PATH: ${cleaned}` };
}

export function commandBackedProfileEntries(normalized) {
  return Object.entries(normalized?.profiles ?? {})
    .filter(([, profile]) => isCommandBackedProfile(profile));
}

export function profileReferenceDetail(normalized, profileName, message) {
  const referenced = referencedProfileNames(normalized).has(profileName);
  return referenced ? `referenced profile "${profileName}": ${message}` : `unreferenced profile "${profileName}": ${message}`;
}

export function rawNpmScriptProfileEntries(rawProfileMeta) {
  return Object.entries(rawProfileMeta ?? {})
    .filter(([, meta]) => typeof meta.rawNpmScript === 'string' && meta.rawNpmScript.trim().length > 0)
    .map(([name, meta]) => [name, meta.rawNpmScript.trim()]);
}

export function packageScripts(packageJsonPath) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return objectValue(pkg.scripts);
}

export function gitStatus(cwd = process.cwd()) {
  const runGit = (args) => spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  const insideResult = runGit(['rev-parse', '--is-inside-work-tree']);
  const insideRepo = insideResult.status === 0 && insideResult.stdout.trim() === 'true';
  if (!insideRepo) {
    return {
      insideRepo: false,
      dirtyFiles: [],
      branch: undefined,
      latestTag: undefined,
      version: undefined,
    };
  }

  const statusResult = runGit(['status', '--short']);
  const dirtyFiles = statusResult.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const branchResult = runGit(['branch', '--show-current']);
  const tagResult = runGit(['describe', '--tags', '--abbrev=0']);
  let version;
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
    version = typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    version = undefined;
  }

  return {
    insideRepo: true,
    dirtyFiles,
    branch: branchResult.status === 0 ? branchResult.stdout.trim() || undefined : undefined,
    latestTag: tagResult.status === 0 ? tagResult.stdout.trim() || undefined : undefined,
    version,
  };
}

export function emit(mode, payload, humanFn) {
  if (mode === 'json') {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${humanFn(payload)}\n`);
}

export async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveFrom(cwd, path) {
  return resolve(cwd, path);
}

export function displayPath(path, cwd = process.cwd()) {
  const resolvedCwd = resolve(cwd);
  const resolvedPath = resolve(path);
  if (dirname(resolvedPath) === resolvedCwd) return basename(resolvedPath);
  return resolvedPath;
}

export function pathList() {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean);
}
