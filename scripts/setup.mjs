/**
 * Interactive first-run setup wizard for VibeCodingAssistant-ElonMa assistant distribution.
 * Creates local env/config files, fills missing launch settings, and runs preflight.
 * Author: VibeCodingAssistant-ElonMa distribution tooling
 */

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process, { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  collectRequiredEnvNames,
  effectiveEnvValue,
  isPlaceholderValue,
  loadConfig,
  parseEnvFile,
} from './lib/preflightCore.mjs';

const MIN_NODE_MAJOR = 18;
const ENV_EXAMPLE = '.env.example';
const ENV_LOCAL = '.env.local';
const CONFIG_EXAMPLE = 'assistant.config.example.json';
const CONFIG_LOCAL = 'assistant.config.local.json';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PREFLIGHT_SCRIPT = path.join(SCRIPT_DIR, 'preflight.mjs');
const WORKFLOW_DIFFICULTIES = ['low', 'medium', 'high', 'extra-high'];
const HEAVY_WORKFLOW_ROLES = ['architect', 'planReviewer', 'developer', 'finalReviewer'];
const COMMAND_BACKED_KINDS = new Set(['command', 'codex', 'claude']);
const preflightCore = {
  collectRequiredEnvNames,
  effectiveEnvValue,
  isPlaceholderValue,
  loadConfig,
  parseEnvFile,
};

class SetupError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'SetupError';
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const options = {
    help: false,
    nonInteractive: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--non-interactive') {
      options.nonInteractive = true;
    } else {
      throw new SetupError(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`VibeCodingAssistant-ElonMa assistant setup

Usage:
  node scripts/setup.mjs [--non-interactive]

Options:
  --non-interactive  Copy missing example files and run preflight without prompts.
  -h, --help         Show this help text.
`);
}

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new SetupError(
      `Node.js ${MIN_NODE_MAJOR} or newer is required. Current version: ${process.versions.node}`,
    );
  }

  console.log(`[ok] Node.js ${process.versions.node}`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureLocalFile(cwd, exampleName, localName, summary) {
  const examplePath = path.resolve(cwd, exampleName);
  const localPath = path.resolve(cwd, localName);

  if (await exists(localPath)) {
    return { created: false, path: localPath };
  }

  if (!(await exists(examplePath))) {
    throw new SetupError(
      `${localName} does not exist and ${exampleName} was not found. Add ${exampleName} first or create ${localName} manually.`,
    );
  }

  await mkdir(path.dirname(localPath), { recursive: true });
  await copyFile(examplePath, localPath);
  summary.filesWritten.add(localName);
  console.log(`[write] Created ${localName} from ${exampleName}`);
  return { created: true, path: localPath };
}

async function readJsonFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new SetupError(`Failed to read ${path.basename(filePath)}: ${error.message}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SetupError(`Failed to parse ${path.basename(filePath)}: ${error.message}`);
  }
}

async function writeJsonFile(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function ensureObject(parent, key) {
  if (!asPlainObject(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function entriesFromMaybeMap(value) {
  if (value instanceof Map) {
    return Array.from(value.entries());
  }
  if (asPlainObject(value)) {
    return Object.entries(value);
  }
  return [];
}

function valuesFromMaybeIterable(value) {
  if (!value) {
    return [];
  }
  if (value instanceof Set || Array.isArray(value)) {
    return Array.from(value);
  }
  return [value];
}

function isMissingOrPlaceholder(core, value) {
  if (typeof value !== 'string') {
    return true;
  }
  return core.isPlaceholderValue(value);
}

function profileNamesFrom(rawConfig, normalized) {
  const names = new Set();
  for (const name of Object.keys(asPlainObject(rawConfig.profiles) ?? {})) {
    names.add(name);
  }
  for (const [name] of entriesFromMaybeMap(normalized?.profiles)) {
    names.add(name);
  }
  return Array.from(names).sort();
}

function projectEntriesFrom(config) {
  const projects = config?.projects;
  if (Array.isArray(projects)) {
    return projects
      .map((project, index) => ({ id: project?.id, project, index, container: projects }))
      .filter((entry) => typeof entry.id === 'string' && entry.id.trim());
  }

  if (asPlainObject(projects)) {
    return Object.entries(projects)
      .map(([id, project]) => ({ id, project, key: id, container: projects }))
      .filter((entry) => asPlainObject(entry.project));
  }

  return [];
}

function getWorkflowRole(rawConfig, role) {
  const workflowRoles = asPlainObject(rawConfig.workflowRoles);
  const value = workflowRoles?.[role];
  return typeof value === 'string' ? value : '';
}

function setWorkflowRole(rawConfig, role, profileName) {
  ensureObject(rawConfig, 'workflowRoles')[role] = profileName;
}

function getHeavyWorkflowRole(rawConfig, difficulty, role) {
  const workflowRoles = asPlainObject(rawConfig.workflowRoles);
  const difficultyRoles = asPlainObject(workflowRoles?.[difficulty]);
  const value = difficultyRoles?.[role];
  return typeof value === 'string' ? value : '';
}

function setHeavyWorkflowRole(rawConfig, difficulty, role, profileName) {
  const workflowRoles = ensureObject(rawConfig, 'workflowRoles');
  const difficultyRoles = ensureObject(workflowRoles, difficulty);
  difficultyRoles[role] = profileName;
}

function profileLooksOpenAiCompatible(profile) {
  const kind = typeof profile?.kind === 'string' ? profile.kind.trim().toLowerCase() : '';
  return (
    kind === 'openai-compatible' ||
    kind === 'deepseek' ||
    typeof profile?.baseUrl === 'string' ||
    typeof profile?.model === 'string' ||
    typeof profile?.apiKeyEnv === 'string'
  );
}

function profileLooksCommandBacked(profile) {
  const kind = typeof profile?.kind === 'string' ? profile.kind.trim().toLowerCase() : '';
  return COMMAND_BACKED_KINDS.has(kind) || Boolean(String(profile?.command ?? '').trim());
}

function formatProfileList(profileNames) {
  return profileNames.length > 0 ? profileNames.join(', ') : 'none';
}

async function promptText(rl, message, { defaultValue = '', required = false, core } = {}) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  while (true) {
    const answer = (await rl.question(`${message}${suffix}: `)).trim();
    const value = answer || defaultValue;

    if (!required || !isMissingOrPlaceholder(core, value)) {
      return value;
    }

    console.log('Please enter a non-placeholder value, or press Ctrl+C to stop setup.');
  }
}

async function promptOptionalText(rl, message) {
  return (await rl.question(`${message} (leave blank to skip): `)).trim();
}

async function ensureProfile(rawConfig, rl, core, profileName, summary, defaultKind = 'openai-compatible') {
  const profiles = ensureObject(rawConfig, 'profiles');
  if (asPlainObject(profiles[profileName])) {
    return profiles[profileName];
  }

  const kind = await promptText(rl, `Create profile "${profileName}" as kind`, {
    defaultValue: defaultKind,
    required: true,
    core,
  });
  profiles[profileName] = { kind };
  summary.profilesConfigured.add(profileName);
  return profiles[profileName];
}

async function promptProfileSelection(
  rl,
  rawConfig,
  normalized,
  core,
  label,
  current,
  summary,
  defaultKind = 'openai-compatible',
) {
  const names = profileNamesFrom(rawConfig, normalized);
  if (current && names.includes(current) && !core.isPlaceholderValue(current)) {
    return current;
  }

  console.log(`Available profiles: ${formatProfileList(names)}`);
  const defaultValue = names[0] ?? '';
  const answer = await promptText(rl, `Profile for workflow role "${label}"`, {
    defaultValue,
    required: true,
    core,
  });

  if (!answer) {
    return '';
  }

  await ensureProfile(rawConfig, rl, core, answer, summary, defaultKind);
  return answer;
}

async function configureOpenAiCompatibleProfile(rl, rawConfig, core, profileName, summary) {
  const profile = await ensureProfile(rawConfig, rl, core, profileName, summary);
  let changed = false;

  for (const field of ['baseUrl', 'model', 'apiKeyEnv']) {
    if (!isMissingOrPlaceholder(core, profile[field])) {
      continue;
    }
    const answer = await promptOptionalText(rl, `Profile "${profileName}" ${field}`);
    if (answer) {
      profile[field] = answer;
      changed = true;
    }
  }

  if (changed) {
    summary.profilesConfigured.add(profileName);
  }
  return changed;
}

async function configureCommandProfile(rl, profileName, profile, core, summary) {
  if (!profileLooksCommandBacked(profile) || !isMissingOrPlaceholder(core, profile.command)) {
    return false;
  }

  const answer = await promptOptionalText(rl, `Command for profile "${profileName}"`);
  if (!answer) {
    return false;
  }

  profile.command = answer;
  summary.profilesConfigured.add(profileName);
  return true;
}

async function configureWorkspaceAndProjects(rl, rawConfig, normalized, core, summary) {
  let changed = false;
  const workspace = ensureObject(rawConfig, 'workspace');
  const normalizedWorkspace = asPlainObject(normalized?.workspace);

  if (isMissingOrPlaceholder(core, workspace.targetDir ?? normalizedWorkspace?.targetDir)) {
    const answer = await promptText(rl, 'Workspace targetDir', { required: true, core });
    if (answer) {
      workspace.targetDir = answer;
      changed = true;
    }
  }

  for (const entry of projectEntriesFrom(rawConfig)) {
    if (!isMissingOrPlaceholder(core, entry.project?.targetDir)) {
      continue;
    }
    const answer = await promptText(rl, `Project "${entry.id}" targetDir`, {
      required: true,
      core,
    });
    if (answer) {
      entry.project.targetDir = answer;
      changed = true;
    }
  }

  const projectIds = projectEntriesFrom(rawConfig).map((entry) => entry.id);
  const currentDefaultProjectId =
    typeof rawConfig.defaultProjectId === 'string' ? rawConfig.defaultProjectId : '';
  if (
    projectIds.length > 0 &&
    (isMissingOrPlaceholder(core, currentDefaultProjectId) ||
      !projectIds.includes(currentDefaultProjectId))
  ) {
    const answer = await promptText(rl, 'defaultProjectId', {
      defaultValue: projectIds[0],
      required: true,
      core,
    });
    if (answer) {
      rawConfig.defaultProjectId = answer;
      changed = true;
    }
  }

  if (changed) {
    summary.filesWritten.add(CONFIG_LOCAL);
  }
  return changed;
}

async function configureWorkflowAndProfiles(rl, rawConfig, normalized, core, summary) {
  let changed = false;
  const profiles = ensureObject(rawConfig, 'profiles');

  const assistantBefore = getWorkflowRole(rawConfig, 'assistant');
  const assistantSelected = await promptProfileSelection(
    rl,
    rawConfig,
    normalized,
    core,
    'assistant',
    assistantBefore,
    summary,
  );
  if (assistantSelected && assistantSelected !== assistantBefore) {
    setWorkflowRole(rawConfig, 'assistant', assistantSelected);
    changed = true;
  }

  for (const difficulty of WORKFLOW_DIFFICULTIES) {
    for (const role of HEAVY_WORKFLOW_ROLES) {
      const before = getHeavyWorkflowRole(rawConfig, difficulty, role);
      const selected = await promptProfileSelection(
        rl,
        rawConfig,
        normalized,
        core,
        `${difficulty}.${role}`,
        before,
        summary,
        'command',
      );
      if (selected && selected !== before) {
        setHeavyWorkflowRole(rawConfig, difficulty, role, selected);
        changed = true;
      }
    }
  }

  const assistantProfile = getWorkflowRole(rawConfig, 'assistant');
  if (assistantProfile) {
    const profile = profiles[assistantProfile];
    if (!profile || profileLooksOpenAiCompatible(profile)) {
      changed =
        (await configureOpenAiCompatibleProfile(rl, rawConfig, core, assistantProfile, summary)) ||
        changed;
    }
  }

  const normalizedProfileEntries = entriesFromMaybeMap(normalized?.profiles);
  for (const [profileName, normalizedProfile] of normalizedProfileEntries) {
    const rawProfile = asPlainObject(profiles[profileName]) ?? normalizedProfile;
    if (!asPlainObject(profiles[profileName])) {
      profiles[profileName] = { ...normalizedProfile };
    }
    if (profileLooksCommandBacked(rawProfile)) {
      changed =
        (await configureCommandProfile(rl, profileName, profiles[profileName], core, summary)) ||
        changed;
    }
  }

  for (const [profileName, profile] of Object.entries(profiles)) {
    changed =
      (await configureCommandProfile(rl, profileName, profile, core, summary)) || changed;
  }

  if (changed) {
    summary.filesWritten.add(CONFIG_LOCAL);
  }
  return changed;
}

async function configureLark(rl, rawConfig, core, summary) {
  if (!asPlainObject(rawConfig.lark)) {
    return false;
  }

  let changed = false;
  const lark = rawConfig.lark;
  for (const field of ['appIdEnv', 'appSecretEnv']) {
    if (!isMissingOrPlaceholder(core, lark[field])) {
      continue;
    }
    const answer = await promptOptionalText(rl, `Lark ${field}`);
    if (answer) {
      lark[field] = answer;
      changed = true;
    }
  }

  const ids = Array.isArray(lark.allowedOpenIds) ? lark.allowedOpenIds : [];
  const needsAllowedIds =
    ids.length === 0 ||
    ids.some((id) => typeof id !== 'string' || core.isPlaceholderValue(id));
  if (needsAllowedIds) {
    const answer = await promptOptionalText(
      rl,
      'Lark allowedOpenIds, comma-separated open IDs',
    );
    if (answer) {
      lark.allowedOpenIds = answer
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      changed = true;
    }
  }

  summary.larkAllowedIdCount = Array.isArray(lark.allowedOpenIds)
    ? lark.allowedOpenIds.length
    : 0;

  if (changed) {
    summary.filesWritten.add(CONFIG_LOCAL);
  }
  return changed;
}

function collectRequiredEnvNameList(requiredEnv) {
  const names = new Set([
    ...valuesFromMaybeIterable(requiredEnv?.apiKeyEnvs),
    ...valuesFromMaybeIterable(requiredEnv?.larkEnvs),
  ]);

  for (const [, value] of entriesFromMaybeMap(requiredEnv?.byProfile)) {
    for (const name of valuesFromMaybeIterable(value)) {
      names.add(name);
    }
  }

  return Array.from(names)
    .filter((name) => typeof name === 'string' && name.trim())
    .sort();
}

function parseEnvLineKey(line) {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined;
  }
  if (trimmed.startsWith('export ')) {
    trimmed = trimmed.slice('export '.length).trim();
  }
  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex <= 0) {
    return undefined;
  }
  const key = trimmed.slice(0, equalsIndex);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : undefined;
}

function formatEnvAssignment(name, value) {
  if (/[\r\n]/.test(value)) {
    throw new SetupError(`${name} contains a newline, which cannot be written to ${ENV_LOCAL}.`);
  }
  if (/^[^\s#"'=]+$/.test(value)) {
    return `${name}=${value}`;
  }
  if (!value.includes("'")) {
    return `${name}='${value}'`;
  }
  if (!value.includes('"')) {
    return `${name}="${value}"`;
  }
  return `${name}=${value}`;
}

function upsertEnvAssignment(text, name, value) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = text.endsWith('\n') || text.endsWith('\r\n');
  const lines = text.split(/\r?\n/);
  if (hadFinalNewline) {
    lines.pop();
  }

  const replacement = formatEnvAssignment(name, value);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (!replaced && parseEnvLineKey(line) === name) {
      replaced = true;
      return replacement;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim()) {
      nextLines.push('');
    }
    nextLines.push(replacement);
  }

  return `${nextLines.join(newline)}${newline}`;
}

async function configureEnvFile(rl, cwd, core, normalized, summary) {
  const envPath = path.resolve(cwd, ENV_LOCAL);
  const requiredEnv = core.collectRequiredEnvNames(normalized);
  const requiredNames = collectRequiredEnvNameList(requiredEnv);
  if (requiredNames.length === 0) {
    console.log('[skip] No config-derived env var names to prompt for.');
    return false;
  }

  let parsedEnv = await core.parseEnvFile(envPath);
  let envText = await readFile(envPath, 'utf8');
  let changed = false;

  console.log('Env values typed here may be visible in your terminal history or screen.');
  for (const name of requiredNames) {
    const effective = core.effectiveEnvValue(name, parsedEnv);
    if (effective?.value !== undefined && !core.isPlaceholderValue(effective.value)) {
      summary.envNamesDefined.add(name);
      continue;
    }

    const answer = await promptOptionalText(rl, `Value for ${name}`);
    if (!answer) {
      continue;
    }

    envText = upsertEnvAssignment(envText, name, answer);
    changed = true;
    summary.envNamesDefined.add(name);
    parsedEnv = { ...(await core.parseEnvFile(envPath)), vars: new Map(parsedEnv.vars) };
    parsedEnv.vars.set(name, answer);
  }

  if (changed) {
    await writeFile(envPath, envText, 'utf8');
    summary.filesWritten.add(ENV_LOCAL);
  }

  return changed;
}

async function loadSetupConfig(cwd, core) {
  try {
    return await core.loadConfig({ cwd });
  } catch (error) {
    throw new SetupError(`Failed to load setup config: ${error.message}`);
  }
}

async function runInteractive(cwd, core, summary) {
  await ensureLocalFile(cwd, ENV_EXAMPLE, ENV_LOCAL, summary);
  await ensureLocalFile(cwd, CONFIG_EXAMPLE, CONFIG_LOCAL, summary);

  const configPath = path.resolve(cwd, CONFIG_LOCAL);
  let rawConfig = await readJsonFile(configPath);
  const rl = createInterface({ input, output });

  try {
    console.log('\nStep 1. Local config');
    let configState = await loadSetupConfig(cwd, core);
    let changed = await configureWorkspaceAndProjects(
      rl,
      rawConfig,
      configState.normalized,
      core,
      summary,
    );
    changed =
      (await configureWorkflowAndProfiles(rl, rawConfig, configState.normalized, core, summary)) ||
      changed;
    changed = (await configureLark(rl, rawConfig, core, summary)) || changed;

    if (changed) {
      await writeJsonFile(configPath, rawConfig);
      configState = await loadSetupConfig(cwd, core);
    }

    console.log('\nStep 2. Local env');
    await configureEnvFile(rl, cwd, core, configState.normalized, summary);
  } finally {
    rl.close();
  }
}

async function runNonInteractive(cwd, summary) {
  await ensureLocalFile(cwd, ENV_EXAMPLE, ENV_LOCAL, summary);
  await ensureLocalFile(cwd, CONFIG_EXAMPLE, CONFIG_LOCAL, summary);
  console.log('[info] Non-interactive mode does not prompt for missing or placeholder values.');
}

function runPreflight(cwd) {
  console.log('\nStep 3. Running preflight validation');
  const result = spawnSync('node', ['--', PREFLIGHT_SCRIPT], {
    cwd,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Failed to run ${PREFLIGHT_SCRIPT}: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function printSummary(summary) {
  const files = Array.from(summary.filesWritten).sort();
  const envNames = Array.from(summary.envNamesDefined).sort();
  const profiles = Array.from(summary.profilesConfigured).sort();

  console.log('\nSetup summary');
  console.log(`Files written: ${files.length > 0 ? files.join(', ') : 'none'}`);
  console.log(`Env names defined: ${envNames.length > 0 ? envNames.join(', ') : 'none'}`);
  console.log(`Profiles configured: ${profiles.length > 0 ? profiles.join(', ') : 'none'}`);
  console.log(`Lark allowed ID count: ${summary.larkAllowedIdCount}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }

  const cwd = process.cwd();
  const summary = {
    envNamesDefined: new Set(),
    filesWritten: new Set(),
    larkAllowedIdCount: 0,
    profilesConfigured: new Set(),
  };

  checkNodeVersion();

  if (options.nonInteractive) {
    await runNonInteractive(cwd, summary);
  } else {
    await runInteractive(cwd, preflightCore, summary);
  }

  printSummary(summary);
  const status = runPreflight(cwd);
  if (options.nonInteractive && status !== 0) {
    console.error(
      '\nNon-interactive setup stopped after preflight. Edit .env.local and assistant.config.local.json, then run npm run assistant:preflight.',
    );
  }
  return status;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof SetupError) {
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(`Setup failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
