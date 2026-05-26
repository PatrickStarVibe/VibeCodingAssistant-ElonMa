/**
 * Manager assistant launch preflight checker.
 *
 * Runs dependency-free readiness checks before starting the Lark assistant:
 * Node.js version, config source, env names, workspace paths, profile commands,
 * npm script references, and optional doctor diagnostics.
 *
 * Author: Manager distribution tooling
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  collectRequiredEnvNames,
  commandBackedProfileEntries,
  displayPath,
  effectiveEnvValue,
  emit,
  fileExists,
  isPlaceholderValue,
  loadConfig,
  packageScripts,
  parseEnvFile,
  pathList,
  probeExecutable,
  profileReferenceDetail,
  rawNpmScriptProfileEntries,
  validateLarkOpenIds,
  validateProfiles,
  validateWorkspacePaths,
} from './lib/preflightCore.mjs';

const DEFAULT_ENV_FILE = '.env.local';
const LOCAL_CONFIG_FILE = 'assistant.config.local.json';
const EXAMPLE_CONFIG_FILE = 'assistant.config.example.json';
const NODE_MAJOR_MINIMUM = 18;
const CONFIG_DEPENDENT_CHECKS = [
  ['workspace-paths', 'Workspace/project paths'],
  ['profile-compatibility', 'Role/profile compatibility'],
  ['required-env', 'Required environment variable names'],
  ['env-placeholders', 'No placeholder environment values'],
  ['lark-open-ids', 'Lark allowed Open IDs'],
  ['command-profiles', 'Command profiles executable'],
  ['npm-scripts', 'Profile npmScript references'],
];

function parseCli(argv) {
  const options = {
    config: undefined,
    envFile: DEFAULT_ENV_FILE,
    json: argv.includes('--json'),
    doctor: argv.includes('--doctor'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--json' || arg === '--doctor') continue;

    if (arg === '--config') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        return { options, error: '--config requires a path.' };
      }
      options.config = value;
      index += 1;
      continue;
    }

    if (arg === '--env-file') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        return { options, error: '--env-file requires a path.' };
      }
      options.envFile = value;
      index += 1;
      continue;
    }

    return { options, error: `Unknown argument: ${arg}` };
  }

  return { options };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const mode = cli.options.json ? 'json' : 'human';
  const payloadMode = cli.options.doctor ? 'doctor' : 'preflight';

  if (cli.error) {
    const checks = [check('cli', 'CLI arguments', 'fail', cli.error)];
    const payload = buildPayload({ ok: false, mode: payloadMode, checks, options: cli.options });
    emit(mode, payload, renderHuman);
    process.exitCode = 1;
    return;
  }

  const options = cli.options;
  const checks = [];
  const envPath = resolve(process.cwd(), options.envFile);
  const configSource = await resolveConfigSource(options.config);
  let loadedConfig;
  let parsedEnvFile = { vars: new Map(), exists: false };

  checks.push(nodeVersionCheck());
  checks.push(configSource.check);

  parsedEnvFile = await parseEnvFile(envPath);
  checks.push(parsedEnvFile.exists
    ? check('env-file', 'Environment file', 'pass', `found: ${displayPath(envPath)}`)
    : check('env-file', 'Environment file', 'fail', `not found: ${displayPath(envPath)}`));

  if (resolve(process.cwd(), options.envFile) !== resolve(process.cwd(), DEFAULT_ENV_FILE)) {
    checks.push(check(
      'env-file-runtime-notice',
      'Environment file runtime notice',
      'pass',
      `validated ${displayPath(envPath)}; runtime still loads ${DEFAULT_ENV_FILE}`,
    ));
  }

  if (!configSource.ok) {
    pushSkippedChecks(checks, 'skipped: config source failed', { includeConfigNormalizes: true });
  } else {
    loadedConfig = await loadConfigCheck(options, checks);
    if (!loadedConfig) {
      pushSkippedChecks(checks, 'skipped: config normalization failed');
    } else {
      checks.push(workspacePathsCheck(loadedConfig.normalized));
      checks.push(profileCompatibilityCheck(loadedConfig.normalized));
      checks.push(requiredEnvCheck(loadedConfig.normalized, parsedEnvFile));
      checks.push(envPlaceholderCheck(loadedConfig.normalized, parsedEnvFile));
      checks.push(larkOpenIdsCheck(loadedConfig.normalized));
      checks.push(commandProfilesCheck(loadedConfig.normalized));
      checks.push(npmScriptsCheck(loadedConfig.rawProfileMeta));
    }
  }

  const ok = checks.every((entry) => entry.status !== 'fail');
  const payload = buildPayload({
    ok,
    mode: payloadMode,
    source: loadedConfig?.source ?? configSource.source,
    sourceKind: loadedConfig?.sourceKind ?? configSource.sourceKind,
    checks,
    options,
    loadedConfig,
  });

  emit(mode, payload, renderHuman);
  process.exitCode = ok ? 0 : 1;
}

async function resolveConfigSource(explicitPath) {
  if (explicitPath) {
    const source = resolve(process.cwd(), explicitPath);
    if (!(await fileExists(source))) {
      return {
        ok: false,
        source,
        sourceKind: 'explicit',
        check: check('config-source', 'Config source', 'fail', `not found: ${displayPath(source)}`),
      };
    }

    const exampleNotice = source === resolve(process.cwd(), EXAMPLE_CONFIG_FILE)
      ? '; explicit example config is usually not launchable'
      : '';
    return {
      ok: true,
      source,
      sourceKind: 'explicit',
      check: check('config-source', 'Config source', 'pass', `using explicit config: ${displayPath(source)}${exampleNotice}`),
    };
  }

  const localPath = resolve(process.cwd(), LOCAL_CONFIG_FILE);
  if (await fileExists(localPath)) {
    return {
      ok: true,
      source: localPath,
      sourceKind: 'local',
      check: check('config-source', 'Config source', 'pass', `using ${LOCAL_CONFIG_FILE}`),
    };
  }

  const examplePath = resolve(process.cwd(), EXAMPLE_CONFIG_FILE);
  if (await fileExists(examplePath)) {
    return {
      ok: false,
      source: examplePath,
      sourceKind: 'example-only',
      check: check(
        'config-source',
        'Config source',
        'fail',
        `no launchable config - only ${EXAMPLE_CONFIG_FILE} found. Run 'npm run assistant:setup'.`,
      ),
    };
  }

  return {
    ok: false,
    source: undefined,
    sourceKind: 'missing',
    check: check(
      'config-source',
      'Config source',
      'fail',
      `no ${LOCAL_CONFIG_FILE} or ${EXAMPLE_CONFIG_FILE} found.`,
    ),
  };
}

async function loadConfigCheck(options, checks) {
  try {
    const loaded = await loadConfig({
      explicitPath: options.config,
      cwd: process.cwd(),
      allowExampleFallback: false,
    });
    const detail = loaded.warnings.length > 0
      ? `loaded ${displayPath(loaded.source)}; ${loaded.warnings.join(' ')}`
      : `loaded ${displayPath(loaded.source)}`;
    checks.push(check('config-normalizes', 'Config normalizes', 'pass', detail));
    return loaded;
  } catch (error) {
    checks.push(check('config-normalizes', 'Config normalizes', 'fail', error.message));
    return undefined;
  }
}

function nodeVersionCheck() {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return major >= NODE_MAJOR_MINIMUM
    ? check('node-version', 'Node.js version', 'pass', `v${process.versions.node}`)
    : check('node-version', 'Node.js version', 'fail', `v${process.versions.node}; requires >= ${NODE_MAJOR_MINIMUM}`);
}

function workspacePathsCheck(normalized) {
  const { errors } = validateWorkspacePaths(normalized);
  return errors.length > 0
    ? check('workspace-paths', 'Workspace/project paths', 'fail', errors.join(' '))
    : check('workspace-paths', 'Workspace/project paths', 'pass', 'configured');
}

function profileCompatibilityCheck(normalized) {
  const { errors, warnings } = validateProfiles(normalized);
  if (errors.length > 0) {
    return check('profile-compatibility', 'Role/profile compatibility', 'fail', errors.join(' '));
  }
  return check(
    'profile-compatibility',
    'Role/profile compatibility',
    'pass',
    warnings.length > 0 ? warnings.join(' ') : 'configured',
  );
}

function requiredEnvCheck(normalized, parsedEnvFile) {
  const names = requiredEnvNameList(normalized);
  const missing = names.filter((name) => effectiveEnvValue(name, parsedEnvFile).value === undefined);
  return missing.length > 0
    ? check('required-env', 'Required environment variable names', 'fail', `missing: ${missing.join(', ')}`)
    : check('required-env', 'Required environment variable names', 'pass', names.length > 0 ? `defined: ${names.join(', ')}` : 'no required env names');
}

function envPlaceholderCheck(normalized, parsedEnvFile) {
  const names = requiredEnvNameList(normalized);
  const placeholders = names.filter((name) => {
    const { value } = effectiveEnvValue(name, parsedEnvFile);
    return value !== undefined && isPlaceholderValue(value);
  });

  return placeholders.length > 0
    ? check(
      'env-placeholders',
      'No placeholder environment values',
      'fail',
      placeholders.map((name) => `${name} still has placeholder value`).join('; '),
    )
    : check('env-placeholders', 'No placeholder environment values', 'pass', 'no placeholders detected');
}

function larkOpenIdsCheck(normalized) {
  const { errors, warnings } = validateLarkOpenIds(normalized);
  if (errors.length > 0) {
    return check('lark-open-ids', 'Lark allowed Open IDs', 'fail', errors.join(' '));
  }
  return check(
    'lark-open-ids',
    'Lark allowed Open IDs',
    'pass',
    warnings.length > 0 ? warnings.join(' ') : 'configured',
  );
}

function commandProfilesCheck(normalized) {
  const failures = [];
  const checked = [];

  for (const [profileName, profile] of commandBackedProfileEntries(normalized)) {
    checked.push(profileName);
    const result = probeExecutable(profile.command);
    if (!result.ok) {
      failures.push(profileReferenceDetail(normalized, profileName, result.detail));
    }
  }

  return failures.length > 0
    ? check('command-profiles', 'Command profiles executable', 'fail', failures.join(' '))
    : check('command-profiles', 'Command profiles executable', 'pass', checked.length > 0 ? `checked: ${checked.join(', ')}` : 'no command-backed profiles');
}

function npmScriptsCheck(rawProfileMeta) {
  const failures = [];
  const checked = [];
  let scripts = {};

  try {
    scripts = packageScripts(resolve(process.cwd(), 'package.json'));
  } catch (error) {
    failures.push(`package.json scripts could not be read: ${error.message}`);
  }

  for (const [profileName, npmScript] of rawNpmScriptProfileEntries(rawProfileMeta)) {
    checked.push(`${profileName}:${npmScript}`);
    if (!Object.prototype.hasOwnProperty.call(scripts, npmScript)) {
      failures.push(`profile "${profileName}" references missing npm script "${npmScript}".`);
    }
  }

  return failures.length > 0
    ? check('npm-scripts', 'Profile npmScript references', 'fail', failures.join(' '))
    : check('npm-scripts', 'Profile npmScript references', 'pass', checked.length > 0 ? `checked: ${checked.join(', ')}` : 'no npmScript references');
}

function requiredEnvNameList(normalized) {
  const { apiKeyEnvs, larkEnvs } = collectRequiredEnvNames(normalized);
  return [...new Set([...apiKeyEnvs, ...larkEnvs])];
}

function pushSkippedChecks(checks, detail, options = {}) {
  if (options.includeConfigNormalizes) {
    checks.push(check('config-normalizes', 'Config normalizes', 'skipped', detail));
  }
  for (const [id, label] of CONFIG_DEPENDENT_CHECKS) {
    checks.push(check(id, label, 'skipped', detail));
  }
}

function buildPayload({ ok, mode, source, sourceKind, checks, options, loadedConfig }) {
  return {
    ok,
    mode,
    source: source ? displayPath(source) : null,
    sourceKind: sourceKind ?? null,
    checks,
    ...(options.doctor ? { environment: doctorEnvironment(options, source, sourceKind, loadedConfig) } : {}),
  };
}

function doctorEnvironment(options, source, sourceKind, loadedConfig) {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    envFile: displayPath(resolve(process.cwd(), options.envFile)),
    config: source ? displayPath(source) : null,
    sourceKind: sourceKind ?? null,
    configLoaded: Boolean(loadedConfig),
    profiles: loadedConfig ? Object.keys(loadedConfig.normalized.profiles ?? {}) : [],
    pathEntries: pathList().length,
    hasPackageJson: existsSync(resolve(process.cwd(), 'package.json')),
  };
}

function renderHuman(payload) {
  const lines = payload.checks.map((entry) => {
    const marker = entry.status === 'pass' ? '✅' : entry.status === 'fail' ? '❌' : '⚪';
    return `${marker} ${entry.label}${entry.detail ? ` - ${entry.detail}` : ''}`;
  });
  const failedCount = payload.checks.filter((entry) => entry.status === 'fail').length;
  lines.push(failedCount === 0 ? '✅ All checks passed' : `❌ ${failedCount} check(s) failed`);
  if (payload.environment) {
    lines.push(`Doctor: Node ${payload.environment.node}; platform ${payload.environment.platform}/${payload.environment.arch}; PATH entries ${payload.environment.pathEntries}`);
  }
  return lines.join('\n');
}

function check(id, label, status, detail = '') {
  return { id, label, status, detail };
}

try {
  await main();
} catch (error) {
  const cli = parseCli(process.argv.slice(2));
  const mode = cli.options.json ? 'json' : 'human';
  const payload = buildPayload({
    ok: false,
    mode: cli.options.doctor ? 'doctor' : 'preflight',
    checks: [check('unexpected-error', 'Unexpected error', 'fail', error.message)],
    options: cli.options,
  });
  emit(mode, payload, renderHuman);
  process.exitCode = 1;
}
