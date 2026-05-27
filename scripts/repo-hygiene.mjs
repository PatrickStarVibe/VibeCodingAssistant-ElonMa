/*
 * Repo hygiene checker for VibeCodingAssistant-ElonMa distribution and publish readiness.
 * Runs git, ignore-file, lockfile, and package version checks without external dependencies.
 * Author: VibeCodingAssistant-ElonMa distribution tooling
 */

import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MODE = "repo-hygiene";
const REQUIRED_GITIGNORE_PATTERNS = ["node_modules/", ".env.local", ".env"];

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

function trimCommandError(result) {
  if (result.error) {
    return result.error.message;
  }

  return (result.stderr || result.stdout || "command failed").trim();
}

function parseDirtyFiles(statusOutput) {
  return statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const filePath = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop().trim()
        : rawPath;

      return { status, path: filePath };
    });
}

function firstLine(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

export function gitStatus(cwd = process.cwd()) {
  const insideResult = runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  if (!insideResult.ok || insideResult.stdout.trim() !== "true") {
    return {
      insideRepo: false,
      dirtyFiles: [],
      branch: null,
      latestTag: null,
      version: null,
      error: trimCommandError(insideResult),
    };
  }

  const statusResult = runCommand("git", ["status", "--porcelain"], cwd);
  const branchResult = runCommand("git", ["branch", "--show-current"], cwd);
  const headResult = runCommand("git", ["rev-parse", "--short", "HEAD"], cwd);
  const tagResult = runCommand(
    "git",
    ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"],
    cwd,
  );

  const branch = firstLine(branchResult.stdout) || firstLine(headResult.stdout);
  const latestTag = tagResult.ok ? firstLine(tagResult.stdout) : null;

  return {
    insideRepo: true,
    dirtyFiles: statusResult.ok ? parseDirtyFiles(statusResult.stdout) : [],
    branch,
    latestTag,
    version: null,
    error: statusResult.ok ? null : trimCommandError(statusResult),
  };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function readPackageVersion(cwd) {
  const packageJsonPath = path.join(cwd, "package.json");
  const packageJson = await readJsonFile(packageJsonPath);
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("package.json has no non-empty version field");
  }

  return packageJson.version.trim();
}

async function checkGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!(await fileExists(gitignorePath))) {
    return {
      id: "gitignore",
      label: ".gitignore protects local-only files",
      status: "fail",
      detail: "missing .gitignore",
    };
  }

  const text = await readFile(gitignorePath, "utf8");
  const patterns = new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  const missing = REQUIRED_GITIGNORE_PATTERNS.filter((pattern) => !patterns.has(pattern));

  if (missing.length > 0) {
    return {
      id: "gitignore",
      label: ".gitignore protects local-only files",
      status: "fail",
      detail: `missing literal pattern(s): ${missing.join(", ")}`,
    };
  }

  return {
    id: "gitignore",
    label: ".gitignore protects local-only files",
    status: "pass",
    detail: `found ${REQUIRED_GITIGNORE_PATTERNS.join(", ")}`,
  };
}

export async function runHygieneChecks(cwd = process.cwd()) {
  const checks = [];
  const git = gitStatus(cwd);

  checks.push({
    id: "git-repo",
    label: "Inside a git repository",
    status: git.insideRepo ? "pass" : "fail",
    detail: git.insideRepo ? "git repository detected" : git.error || "not inside a git repository",
  });

  if (git.insideRepo) {
    checks.push({
      id: "git-clean",
      label: "Working tree clean",
      status: git.error || git.dirtyFiles.length > 0 ? "fail" : "pass",
      detail: git.error
        ? git.error
        : git.dirtyFiles.length > 0
          ? `${git.dirtyFiles.length} changed or untracked file(s)`
          : "no uncommitted changes",
    });
  } else {
    checks.push({
      id: "git-clean",
      label: "Working tree clean",
      status: "skipped",
      detail: "skipped: not inside a git repository",
    });
  }

  checks.push(await checkGitignore(cwd));

  const packageLockExists = await fileExists(path.join(cwd, "package-lock.json"));
  checks.push({
    id: "package-lock",
    label: "package-lock.json exists",
    status: packageLockExists ? "pass" : "fail",
    detail: packageLockExists ? "package-lock.json found" : "missing package-lock.json",
  });

  let packageVersion = null;
  try {
    packageVersion = await readPackageVersion(cwd);
  } catch (error) {
    checks.push({
      id: "version-bump",
      label: "package.json version bump hint",
      status: "fail",
      detail: `unable to read package.json version: ${error.message}`,
    });
  }

  if (packageVersion !== null) {
    git.version = packageVersion;
    if (!git.insideRepo) {
      checks.push({
        id: "version-bump",
        label: "package.json version bump hint",
        status: "skipped",
        detail: `package version is ${packageVersion}; skipped: not inside a git repository`,
      });
    } else if (!git.latestTag) {
      checks.push({
        id: "version-bump",
        label: "package.json version bump hint",
        status: "warn",
        detail: `package version is ${packageVersion}; no vX.Y.Z git tag found`,
      });
    } else if (git.latestTag === `v${packageVersion}`) {
      checks.push({
        id: "version-bump",
        label: "package.json version bump hint",
        status: "warn",
        detail: `package version ${packageVersion} matches latest tag ${git.latestTag}; consider bumping before publish`,
      });
    } else {
      checks.push({
        id: "version-bump",
        label: "package.json version bump hint",
        status: "pass",
        detail: `package version ${packageVersion}; latest tag ${git.latestTag}`,
      });
    }
  }

  const summary = summarize(checks);
  return {
    ok: summary.fail === 0,
    mode: MODE,
    cwd,
    git: {
      insideRepo: git.insideRepo,
      branch: git.branch,
      latestTag: git.latestTag,
      dirtyFileCount: git.dirtyFiles.length,
      dirtyFiles: git.dirtyFiles,
      version: git.version,
    },
    checks,
    summary,
  };
}

function summarize(checks) {
  return checks.reduce(
    (summary, check) => {
      if (check.status in summary) {
        summary[check.status] += 1;
      }
      return summary;
    },
    { pass: 0, fail: 0, warn: 0, skipped: 0 },
  );
}

function parseArgs(argv) {
  const options = { json: false, help: false };

  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function humanStatus(status) {
  return {
    pass: "PASS",
    fail: "FAIL",
    warn: "WARN",
    skipped: "SKIP",
  }[status] ?? status.toUpperCase();
}

function formatHuman(payload) {
  if (payload.help) {
    return [
      "VibeCodingAssistant-ElonMa repo hygiene checker",
      "",
      "Usage: node scripts/repo-hygiene.mjs [--json]",
      "",
      "Checks git state, .gitignore safeguards, package-lock.json, and package version hints.",
    ].join("\n");
  }

  const lines = ["VibeCodingAssistant-ElonMa repo hygiene check", ""];
  for (const check of payload.checks) {
    lines.push(`${humanStatus(check.status)} ${check.label} - ${check.detail}`);
  }

  lines.push("");
  lines.push(
    `Summary: ${payload.ok ? "PASS" : "FAIL"} (${payload.summary.pass} passed, ${payload.summary.fail} failed, ${payload.summary.warn} warning(s), ${payload.summary.skipped} skipped)`,
  );

  return lines.join("\n");
}

function emitPayload(payload, json) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatHuman(payload));
  }
}

function errorPayload(message) {
  return {
    ok: false,
    mode: MODE,
    checks: [
      {
        id: "repo-hygiene",
        label: "Repo hygiene check",
        status: "fail",
        detail: message,
      },
    ],
    summary: { pass: 0, fail: 1, warn: 0, skipped: 0 },
  };
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const wantsJson = argv.includes("--json");

  try {
    const options = parseArgs(argv);
    if (options.help) {
      const payload = { ok: true, mode: MODE, help: true };
      emitPayload(payload, options.json);
      return 0;
    }

    const payload = await runHygieneChecks(cwd);
    emitPayload(payload, options.json);
    return payload.ok ? 0 : 1;
  } catch (error) {
    const payload = errorPayload(error.message);
    emitPayload(payload, wantsJson);
    return 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedFile === currentFile) {
  process.exitCode = await main();
}
