# Plan: Distribution Tooling — Preflight + Setup + Hygiene + Windows Launchers (Round 3, revised v6)

## Goal

Add launch-readiness tooling and Windows entry points so a fresh user can clone, configure, and start Manager without reading source. **No new runtime dependencies. No edits to `conversation.ts` / `orchestrator.ts`. No hard-coded provider names or absolute paths.** Required env-var names are derived dynamically from `assistant.config*.json` (per user direction A).

## Category

Assistant / Workflow

## Authoritative Env-Var Contract (B3, prior round — unchanged)

`MANAGER_API_KEY` / `MANAGER_AGENT_ID` are **not present anywhere** in `src/`, `types.ts`, or example configs. The live runtime contract uses `ASSISTANT_API_KEY`, `ROLE_AGENT_API_KEY`, `LARK_APP_ID`, `LARK_APP_SECRET`. Per user direction A, preflight derives the required env-name list dynamically from the resolved config:

- `profiles.<name>.apiKeyEnv` for every openai-compatible profile referenced by `workflowRoles.assistant` and by any role profile whose effective shape (post-normalization) is `openai-compatible`.
- `lark.appIdEnv` and `lark.appSecretEnv` when the `lark` block is present.
- Deduplicated. Values never printed.

Tests assert this contract (a) `apiKeyEnv: "ASSISTANT_API_KEY"` triggers a required-env check for `ASSISTANT_API_KEY`; (b) preflight does not hard-require `MANAGER_*` by name.

## Profile-Wide Validation Scope — Resolves B5

The Round-3 task text says *"如果 assistant.config.json 中某个 profile 有 command 字段, 检查对应命令是否在 PATH 中"* — i.e., **any** profile with a `command` field, not just referenced ones. Round 5's narrowing to workflow-role-referenced profiles was wrong. New rule:

- **Command probing scope:** every profile in `normalizedConfig.profiles` whose effective shape is command-backed (per `adapters.ts` rule: `kind in {command, codex, claude}` OR non-empty `command`) is probed via `probeExecutable`.
- **`npmScript` probing scope:** every profile whose `rawProfileMeta[name].rawNpmScript` is a non-empty string is checked against `package.json.scripts`.
- **Severity:**
  - If the failing profile is referenced by `workflowRoles.assistant` or any tier in `workflowRoles` (low/medium/high/extra-high) → **blocking failure** (`status: "fail"`).
  - If the failing profile is unreferenced (orphan profile sitting in config) → **blocking failure** as well, but with `detail` prefixed `unreferenced profile '<name>': …`. Round 6 had treated these as warnings; the task spec wording does not, and B5 explicitly asks for failure unless the user approves launch-role-only semantics. The user did not approve narrowing, so **all profiles' command/npmScript are validated as failures**.
- **Skipped only when example-only invoked explicitly via `--config example` and the example contains only known placeholder commands** — those still fail; this is intentional, since the example is not a launchable config.

Tests cover both referenced-failure and unreferenced-failure fixtures.

## Env-File Parser Mirrors Runtime — Resolves B6

`scripts/lib/preflightCore.mjs::parseEnvFile` mirrors `src/config.ts::parseEnvLocal` exactly:

1. Split on `/\r?\n/`.
2. Trim line; skip blank or `#`-leading.
3. Strip leading `export ` (note the trailing space) once if present, then re-trim.
4. Find first `=`; require index > 0.
5. Validate key against `/^[A-Za-z_][A-Za-z0-9_]*$/`; otherwise skip line.
6. Apply the same `unquoteEnvValue` rules as runtime: strip a single matching pair of `"`/`'` if both ends match; otherwise keep raw value as-is. The helper duplicates runtime's behavior; it does **not** import the TypeScript module (helper is pure ESM).
7. Never log values.

Tests cover:

- `export ASSISTANT_API_KEY=sk-…`
- `export LARK_APP_ID="cli_…"` and `export LARK_APP_SECRET='secret with spaces'`
- Mixed `export`-prefixed and unprefixed lines.
- Lines with invalid keys (`1FOO=bar`, `FOO BAR=baz`) are silently skipped, matching runtime.
- An env file containing only `export`-prefixed assignments passes env-name checks without any value being printed.

## Workspace/Project Path Rule — Resolves B7

The runtime's `defaultConfig()` (src/config.ts:56) embeds `E:/GameDeveloping/IReader/my-reader` — a machine-local absolute path that must never leak through this tooling. Resolution:

- The shared helper does **not** import or replicate `defaultConfig`. Its `loadConfig` constructs an "empty base" — the same shape `normalizeConfig` returns when given a config that *does* specify every field — but with `workspace.targetDir`, `project.targetDir`, and `defaultProjectId` left as `null`/`undefined` instead of substituted.
- A new `validateWorkspacePaths(normalized)` check is added to preflight:
  - **Fail** if `workspace.targetDir` is missing, blank, or matches the placeholder pattern (`replace_me`, `your_*_here`, etc.).
  - **Fail** if any project listed under `projects` has a missing/blank/placeholder `targetDir`.
  - **Fail** if `defaultProjectId` is set but does not match any `projects[].id`.
- The helper's normalized output is the source of truth; setup wizard reads from it and never writes a runtime-default path.
- Setup-leak guard test: after `setup.mjs --non-interactive` against a fixture missing `workspace.targetDir`, assert the generated `assistant.config.local.json` does **not** contain the runtime default's `targetDir` literal (read at test time from `defaultConfig()` so the test stays correct if the runtime default ever changes).

This is the explicit rule B7 asks for: **never default `targetDir` from runtime; fail with a named check.** Preflight thus diverges from runtime only in being stricter — runtime accepts a missing `workspace.targetDir` because it silently substitutes `defaultConfig`'s path; preflight refuses to do so. Documented in `docs/agent-setup-guide.md`.

## Config Source Behavior (prior round B4 — unchanged)

| Invocation | Behavior |
|---|---|
| `--config <path>` explicit, file exists | Load and validate; `sourceKind: "explicit"`. Non-blocking notice when path resolves to `assistant.config.example.json`. |
| `--config <path>` explicit, file missing | Blocking `config-source` failure. |
| No `--config`, `assistant.config.local.json` exists | Load; `sourceKind: "local"`. |
| No `--config`, only `assistant.config.example.json` | **Blocking** `config-source: no launchable config — only assistant.config.example.json found. Run 'npm run assistant:setup'`. |
| Neither file exists | Blocking `config-source: no assistant.config.local.json or assistant.config.example.json found.` |

Subsequent checks emit `status: "skipped"` after a `config-source` failure.

## Env-File Resolution (prior round B2 — unchanged)

`--env-file` semantics: default is `.env.local`; missing path = blocking failure named `env-file: not found: <path>`, in both human and JSON modes. Once loaded, runtime precedence applies (`process.env.NAME` wins when defined, even when empty). Non-default `--env-file` success path emits the "runtime still loads .env.local" notice.

## Runtime-Mirroring Semantics (prior round — unchanged except for B7)

- **Two-stage processing** for `npmScript` survival: snapshot raw `{ rawNpmScript, rawHasCommand, rawKind }` per profile name **before** normalization.
- **Normalization mirrors `normalizeConfig`** for shape rules only: legacy `kind: "deepseek"` → `"openai-compatible"`; strip blanks; inherit `workflowRoles["extra-high"]` from `workflowRoles.high` when missing.
- **Profile classification mirrors `adapters.ts`:** command-backed = `kind in {command, codex, claude}` OR non-empty `command`; openai-compatible = effective `model` + `baseUrl` + `apiKeyEnv`.
- **Env precedence:** `process.env[name] !== undefined` wins; else parsed env-file value; empty/placeholder → fail.
- **Workspace base:** empty (per B7), not `defaultConfig()`.

## Shared Pure-ESM Helper

Create `scripts/lib/preflightCore.mjs` — pure ESM, only `node:` builtins. Exports:

- `parseEnvFile(path) → { vars: Map<string,string>, exists: boolean }` — mirrors `parseEnvLocal` per B6.
- `loadConfig({ explicitPath, cwd, allowExampleFallback }) → { rawProfileMeta, normalized, source, sourceKind, warnings }` — `allowExampleFallback` defaults to `false`; `normalized` uses an empty base (no machine-local path).
- `effectiveEnvValue(name, parsedEnvFile) → { value, source }`.
- `collectRequiredEnvNames(normalized) → { apiKeyEnvs, larkEnvs, byProfile }`.
- `isPlaceholderValue(value) → boolean` — rejects `replace_me`, `cli_xxx`, `xxx`, `your_*_here`, `ou_your_open_id_here`, empty, all-whitespace; case-insensitive.
- `validateProfiles(normalized, rawProfileMeta) → { errors, warnings }` — assistant openai-compatible; workflow role profiles command-backed; unresolved reference = error.
- `validateWorkspacePaths(normalized) → { errors }` — **new for B7.**
- `validateLarkOpenIds(normalized) → { errors, warnings }`.
- `probeExecutable(command) → { ok, mode, detail }` — corrected path-like detection per B1: only `/`/`\`, drive letter, UNC, or relative-prefix is path-like; bare dotted names (`node.exe`, `fake-agent.cmd`) resolve via `where`/`which`.
- `gitStatus(cwd) → { insideRepo, dirtyFiles, branch, latestTag, version }`.
- `emit(mode, payload, humanFn)` — JSON-mode = stdout-only JSON, even on errors.

## Execution Unit 01: Documentation tightening (Part 0)

Edit `docs/agent-setup-guide.md` around line 79 / "Forbidden Behavior" / "Editable Files":

- Agent may check whether `.env.local` **exists**.
- Agent may check whether required env-var **names** exist (not values).
- Reading any env value requires the user's explicit, in-conversation permission; values must never be written to logs, task records, or commits.

Preserve UTF-8 (no BOM); no other rewrites.

## Execution Unit 02: Shared core helper (`scripts/lib/preflightCore.mjs`)

Implement first; everything depends on it. Top-of-file comment block (purpose, exports, `// Author: Manager distribution tooling`). Implement every function listed above, including `validateWorkspacePaths`. Critical invariants:

- `parseEnvFile` mirrors `parseEnvLocal` (B6).
- `loadConfig` captures `rawProfileMeta` *before* normalization; `allowExampleFallback` defaults to `false`; empty base for normalization (B7).
- `probeExecutable` path-like detection limited to separator/drive/UNC/relative prefix (B1).
- No imports from `src/`; no `defaultConfig` replication.

Unit tests in EU 08.

## Execution Unit 03: Package scripts (Part 2)

Edit `package.json` (`scripts` only):

```json
"assistant:preflight": "node scripts/preflight.mjs",
"assistant:start":     "node scripts/preflight.mjs && npm run assistant:lark",
"assistant:setup":     "node scripts/setup.mjs",
"assistant:doctor":    "node scripts/preflight.mjs --doctor",
"assistant:hygiene":   "node scripts/repo-hygiene.mjs",
"prepublishOnly":      "npm run assistant:preflight"
```

No new dependencies.

## Execution Unit 04: Preflight checker (Part 1)

Create `scripts/preflight.mjs`. Top-of-file comment.

- **CLI flags:** `--config <path>`, `--env-file <path>` (default `.env.local`, always required to exist), `--json`, `--doctor`.
- **Top-level try/catch** ensures `--json` mode emits stdout JSON only on parse/IO/CLI errors.
- **Checks** (each yields `{ id, label, status, detail }`):
  1. **Node ≥ 18.**
  2. **Config source resolution.** (B4)
  3. **Env file present** at resolved path. (B2)
  4. **Config normalizes.**
  5. **Workspace/project paths** via `validateWorkspacePaths`. (B7) — fails on missing/blank/placeholder `workspace.targetDir`, project `targetDir`, or unresolved `defaultProjectId`.
  6. **Role/profile compatibility** via `validateProfiles`.
  7. **Required env names present** — config-derived (B3); checks effective values via `effectiveEnvValue`.
  8. **No placeholder values** — applied to effective values; `<NAME> still has placeholder value` (no echo).
  9. **Lark allowed-IDs sanity** — blocks on empty/placeholder `allowedOpenIds`.
  10. **Command profiles executable** — **all** profiles whose effective shape is command-backed are probed (B5). Failures attributed by name; referenced-vs-orphan distinguished only in `detail`.
  11. **`npmScript` from raw profile meta** — for **every** profile with a non-empty `rawNpmScript` (B5), verify the script exists in `package.json`.
- **Skip semantics:** when check 2 fails, checks 4–11 emit `status: "skipped"` with `detail: "skipped: config source failed"`; run is `ok: false`.
- **Output:** human (`✅`/`❌ <label> — <detail>`, summary line) or JSON (`{ ok, mode, source, sourceKind, checks, environment? }`).
- **Exit:** 0 on all-pass, 1 otherwise.
- **Non-default `--env-file` notice:** appended check noting runtime still loads `.env.local`.

## Execution Unit 05: Setup wizard (Part 4)

Create `scripts/setup.mjs`. Top-of-file comment.

- Pure ESM + `node:readline/promises`. Imports `preflightCore.mjs`.
- **Idempotent**; never overwrites existing values.
- Steps:
  1. Node version gate.
  2. `.env.local` — copy from `.env.example` if missing; prompt only for config-derived required names with missing/placeholder effective values; warn about terminal echo; preserve other lines verbatim.
  3. `assistant.config.local.json` — copy from example if missing; **must explicitly prompt for `workspace.targetDir`** (per B7) since the helper provides no runtime default; walk the normalized config and prompt for `defaultProjectId`, assistant fields, command-backed role `command`s, workflow role mapping per tier, lark allowed IDs.
  4. Final validation via `spawnSync('node', ['scripts/preflight.mjs'])`. Setup exits 0 only when preflight passes.
- Summary block: files written, env names defined (names only), profiles configured, lark allowed-ID count.
- `--non-interactive` mode: copy `*.example.*` → `*.local.*` if missing; run preflight; exit 1 on placeholders with the documented hint message; idempotent.

## Execution Unit 06: Repo hygiene check (Part 5)

Create `scripts/repo-hygiene.mjs`. Top-of-file comment.

- Imports `gitStatus`. Top-level try/catch ensures `--json` stdout-only on errors.
- Checks: inside git repo; clean working tree; `.gitignore` contains literal `node_modules`, `.env.local`, `.env`; `package-lock.json` present; version-bump heuristic vs latest `vX.Y.Z` tag (soft warning).
- Output: human or `--json` stdout-only.
- Exit 0/1. Documented as expected-fail during this implementation; not part of `prepublishOnly`.

## Execution Unit 07: Windows launchers (Part 3)

Create at repo root with top-of-file comment.

- **`start-assistant.bat`** — pure batch: `chcp 65001 >nul`, `cd /d "%~dp0"`, `where node`/`where npm` gates with install hints, banner explaining preflight runs inside `assistant:start`, `call npm run assistant:start`, final `pause`.
- **`start-assistant.ps1`** — `Set-Location $PSScriptRoot`, `Get-Command node`/`Get-Command npm` gates, colored stage banners with the same preflight-attribution line, `npm run assistant:start`, `try/catch` + `Read-Host` to keep window open.

## Execution Unit 08: Automated tests

Create `tests/preflight-core.test.ts`, `tests/preflight.test.ts`, `tests/repo-hygiene.test.ts` using existing Vitest. Standard top-of-file comment block per file. Spawn scripts with `process.execPath` and absolute path computed from `path.resolve(__dirname, "..", "scripts", ...)`; `cwd` = fixture dir.

Coverage:

- **`parseEnvFile` (B6):** quotes, comments, blank lines, `KEY=` empty, `export KEY=value`, `export KEY="value with spaces"`, mixed export/non-export, invalid keys silently skipped, fixture using only export-prefixed assignments passes env-name checks with no value printed.
- `collectRequiredEnvNames`: dedupes; assistant + roles; ignores command profiles for api-key list; includes `lark.*Env`.
- `isPlaceholderValue`: rejects all `.env.example` literals.
- `validateProfiles`: `deepseek`-normalized assistant; `codex`/`claude` role profiles; profile with non-empty `command` and no `kind`; missing `extra-high` inherits from `high`.
- **`validateWorkspacePaths` (B7):** fixture omitting `workspace.targetDir` fails with named check; fixture with placeholder `your_path_here` fails; fixture with `defaultProjectId` not matching any project fails; valid fixture passes.
- `rawProfileMeta` survives normalization (`npmScript` detection).
- **`probeExecutable` (B1):** empty/whitespace fail; bare `node` pass; bare dotted command (`fake-agent.cmd`) under temp PATH passes; bare `node.exe` resolves via PATH; quoted absolute Windows path with spaces accepted; `.cmd`/`.exe`/`.bat` siblings for path-like inputs.
- `effectiveEnvValue`: empty `process.env.NAME` overrides valid `.env.local` and triggers placeholder failure.
- `validateLarkOpenIds`: empty fails; `["ou_your_open_id_here"]` fails; realistic IDs pass.
- **Config source semantics (B4):** four fixtures (example-only default-fail, example-only with explicit `--config` proceeds, neither-file fails, local-only succeeds), plus missing-explicit-path JSON-mode parseable.
- **`--env-file` semantics (B2):** missing path exits 1 in both human and JSON modes, named check `detail` includes path, no secret values printed; non-default success path emits "runtime still loads .env.local" notice.
- **Profile-wide validation (B5):**
  - Fixture A: an unreferenced profile has `command: "definitely-missing-cli"` → preflight exits 1 with named profile-level failure.
  - Fixture B: an unreferenced profile has `npmScript: "missing:script"` → preflight exits 1 with named `npmScript` failure.
  - Fixture C: a referenced workflow-role profile has missing command → preflight exits 1 (severity matches Fixture A's exit code; `detail` is referenced-prefixed vs orphan-prefixed).
- `preflight.mjs --json` parseable; `--doctor --json` includes `environment` block; malformed config + `--json` still parseable; bad CLI args + `--json` still parseable.
- **Env-var contract (B3):** fixture with `apiKeyEnv: "ASSISTANT_API_KEY"` triggers required-env check for that name; second fixture without `MANAGER_*` references passes — confirming `MANAGER_*` not hard-required.
- `repo-hygiene.mjs --json`: stdout-only invariant; missing `.gitignore` patterns surface as named checks.
- `setup.mjs --non-interactive`: idempotent across two runs; exit 1 when placeholders remain; never logs values; **leak guard (B7):** generated `assistant.config.local.json` contains no literal substring of the runtime `defaultConfig()`'s `workspace.targetDir`.
- **Launcher content tests:** `start-assistant.bat` contains `cd /d "%~dp0"`, `where node`, `where npm`, preflight banner; `start-assistant.ps1` contains `Set-Location $PSScriptRoot`, `Get-Command node`, `Get-Command npm`, equivalent banner.

## Execution Unit 09: Docs & scripts convergence (Part 6)

- **`START_HERE.md`** — insert "Quick start with setup wizard / 快速启动" block: `npm run assistant:setup`, `npm run assistant:preflight`, `npm run assistant:start`, two Windows launchers. Note `--env-file` always validates the named file but runtime still loads `.env.local`. Note default preflight requires `assistant.config.local.json`. State that Windows launchers run preflight via `assistant:start`. Maintainer note for `npm run assistant:hygiene`. Preserve UTF-8 (no BOM, no line-ending change).
- **`docs/agent-setup-guide.md`** — under "Validation Commands" add `npm run assistant:preflight` first. Document config source resolution; env-var contract correction; **the workspace.targetDir rule (B7): preflight does not silently substitute the runtime default; missing/placeholder `workspace.targetDir` blocks launch and is the supported escape hatch from runtime's machine-local default**. Cross-reference EU 01's three-bullet rule. Preserve UTF-8.
- Confirm every new file starts with top-of-file comment block.

## Files Touched

- **New:** `scripts/lib/preflightCore.mjs`, `scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/repo-hygiene.mjs`, `tests/preflight-core.test.ts`, `tests/preflight.test.ts`, `tests/repo-hygiene.test.ts`, `start-assistant.bat`, `start-assistant.ps1`.
- **Edited:** `package.json` (scripts only), `START_HERE.md`, `docs/agent-setup-guide.md`.
- **Untouched:** `src/conversation.ts`, `src/orchestrator.ts`, `src/workflow.ts`, all provider profile types, `.env.example`, `assistant.config.example.json`.

## Risks & Mitigations

- **All-profile validation noisy on intentionally-disabled profiles (B5)** — `detail` distinguishes referenced vs orphan; doc note explains how to remove unused profiles or replace placeholder commands. Severity remains failure per task spec wording.
- **Env parser divergence from runtime (B6)** — helper mirrors `parseEnvLocal` semantics line-for-line; tests assert export-prefixed assignments and invalid-key skips.
- **Workspace path leak (B7)** — helper uses empty base; `validateWorkspacePaths` fails missing/placeholder `targetDir`; setup leak-guard test asserts runtime default never appears in generated config.
- **Example-only false-pass (B4)** — `allowExampleFallback: false` by default.
- **Dotted bare commands (B1)** — path-like detection corrected.
- **`--env-file` silent fallback (B2)** — required regardless of source.
- **`MANAGER_*` mismatch (B3)** — config-derived contract; tests assert.
- **`npmScript` field loss** — captured pre-normalization.
- **Lark "ghost-running"** — `validateLarkOpenIds` blocks placeholders.
- **`prepublishOnly` scope** — task spec only.
- **Cross-shell `&&`** — npm ≥ 7.
- **Non-ASCII path** — `path.resolve(process.cwd(), ...)`; `.bat` UTF-8 codepage; doc edits preserve UTF-8 without BOM.
- **Secrets safety** — preflight + setup never echo values.
- **Test path resolution** — `process.execPath` + absolute script path; `cwd` = fixture.

## Success Criteria

1. `npm run assistant:preflight` exits 1 on a fresh clone (placeholders) with named failing checks; exits 0 on a fully configured repo.
2. Default preflight against an example-only directory exits 1 with named `config-source` failure.
3. Explicit `--config assistant.config.example.json` proceeds normally.
4. `npm run assistant:preflight -- --json` emits stdout parseable by `JSON.parse` with zero non-JSON characters, including on malformed config or bad CLI args.
5. `npm run assistant:doctor -- --json` adds `environment` block; remains JSON-only.
6. `npm run assistant:setup -- --non-interactive` is idempotent; exits 1 with placeholders; generated config contains no runtime-default machine path.
7. `npm run assistant:hygiene` flags uncommitted changes and missing `.gitignore` patterns; JSON stdout-only. Will fail during this implementation; not gating.
8. Double-clicking either Windows launcher runs preflight via `assistant:start` and gates on node **and** npm.
9. `npm test` passes; `npm run build` passes.
10. No new entries in `dependencies` or `devDependencies`.
11. `probeExecutable` resolves bare dotted commands via PATH; tests prove this.
12. `--env-file does-not-exist.env` exits 1 with named check in both modes.
13. Preflight requires config-derived env names; does not hard-require `MANAGER_*` by name.
14. **(B5)** Preflight fails when any profile (referenced or unreferenced) has an unresolvable `command` or an `npmScript` not present in `package.json.scripts`.
15. **(B6)** Preflight passes against an env file that uses only `export KEY=value` lines, mirroring runtime parser behavior.
16. **(B7)** Preflight fails with a named workspace/project path check when `workspace.targetDir` is missing/blank/placeholder, and setup output never contains the runtime `defaultConfig()` machine-local path.

## Verification Commands

```powershell
node scripts/preflight.mjs --config assistant.config.example.json
node scripts/preflight.mjs --config assistant.config.local.json
node scripts/preflight.mjs --config does-not-exist.json --json
node scripts/preflight.mjs --env-file does-not-exist.env
node scripts/preflight.mjs --env-file does-not-exist.env --json
node scripts/preflight.mjs
node scripts/preflight.mjs --json
node scripts/preflight.mjs --doctor
node scripts/preflight.mjs --doctor --json
node scripts/setup.mjs --non-interactive
node scripts/repo-hygiene.mjs --json
npm run assistant:preflight
npm run assistant:doctor
npm run build
npm test
```
