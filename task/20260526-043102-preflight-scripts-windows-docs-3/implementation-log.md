## Execution Unit 01: Documentation tightening (Part 0)

已完成当前执行单元 Task 01，仅修改文档安全措辞。

变更文件：
- [docs/agent-setup-guide.md](C:/Users/24600/OneDrive/文档/Manager/docs/agent-setup-guide.md:18)

调整内容：
- `.env.local` 只允许检查文件是否存在。
- 只允许检查 required env var name 是否存在，不读取值。
- 读取任何 env value 前必须获得用户明确的对话许可。
- 移除了 “has a non-empty value” 这类会暗示读取值的表述。

Test Result：
- 未运行自动化测试：本单元仅为 Markdown 文档修改。
- 已运行 focused verification：
  - `rg` 确认旧的不安全短语已移除，新权限规则存在。
  - `git diff --check -- docs/agent-setup-guide.md` 通过；Git 仅提示 autocrlf 换行警告。
  - 确认文件无 UTF-8 BOM。

## Execution Unit 02: Shared core helper (`scripts/lib/preflightCore.mjs`)

Implemented Execution Unit 02 only.

Added [scripts/lib/preflightCore.mjs](<C:/Users/24600/OneDrive/文档/Manager/scripts/lib/preflightCore.mjs:1>) with the shared pure-ESM helper for env parsing, config loading/normalization, env-name collection, profile/workspace/Lark validation, executable probing, git status, and output emission. It does not import from `src/` and does not inherit the runtime machine-local `defaultConfig()` path.

Test Result:
- `node --check .\scripts\lib\preflightCore.mjs` passed.
- Assertion-based Node smoke validation passed: env parser parity, explicit example config load, placeholder workspace detection, required env-name collection, Lark/profile validation, `probeExecutable("node")`, and env precedence.

Full `npm test` was not run because automated tests are a later execution unit.

Changed files:
- `scripts/lib/preflightCore.mjs`

## Execution Unit 03: Package scripts (Part 2)

Implemented Task 03 only.

Changed file:
- [package.json](C:/Users/24600/OneDrive/文档/Manager/package.json:48)

Added the approved scripts:
`assistant:preflight`, `assistant:start`, `assistant:setup`, `assistant:doctor`, `assistant:hygiene`, and `prepublishOnly`.

Test Result:
- Passed: `package.json` parses with `JSON.parse`.
- Passed: verified all six new script values via Node.
- Not run: `npm run assistant:*`, because this execution unit only wires scripts; `scripts/preflight.mjs`, `scripts/setup.mjs`, and `scripts/repo-hygiene.mjs` belong to later units. Note also that `assistant:start` now references the approved `assistant:lark` target, but that script is not currently defined elsewhere in `package.json`.

## Execution Unit 04: Preflight checker (Part 1)

Implemented Task 04: added [scripts/preflight.mjs](C:/Users/24600/OneDrive/文档/Manager/scripts/preflight.mjs).

What it covers:
- Node >= 18 check
- config source resolution with skip semantics
- `.env.local` / `--env-file` validation
- config normalization via `scripts/lib/preflightCore.mjs`
- workspace/project path validation
- profile compatibility validation
- config-derived required env names
- placeholder env detection without printing values
- Lark allowed Open ID sanity
- all command-backed profile executable checks
- raw `npmScript` profile checks against `package.json`
- `--json` and `--doctor` modes with JSON-only error output

Test results:
- `node --check scripts\preflight.mjs` passed.
- `node -- scripts\preflight.mjs --config does-not-exist.json --json` returned expected exit `1` with parseable JSON.
- `node -- scripts\preflight.mjs --env-file does-not-exist.env --json` returned expected exit `1` with parseable JSON.
- `node -- scripts\preflight.mjs --doctor --json` returned parseable JSON and included `environment`.

Current repo-state blockers observed, not changed in this unit:
- target workspace has no `.env.local`, so preflight correctly fails that check.
- `package.json` is currently malformed from existing changes, so the npm script check fails while trying to parse it.
- On Node v24, direct `node scripts/preflight.mjs --env-file ...` is intercepted by Node’s own `--env-file` flag. The pass-through form works: `node -- scripts/preflight.mjs --env-file ...`.

Changed file for this execution unit:
- `scripts/preflight.mjs`

## Execution Unit 05: Setup wizard (Part 4)

Implemented Task 05 setup wizard in [scripts/setup.mjs](C:/Users/24600/OneDrive/文档/Manager/scripts/setup.mjs:1).

It now provides an idempotent ESM setup CLI with:
- Node >= 18 gate.
- `.env.local` / `assistant.config.local.json` creation from examples.
- Interactive config prompts using config-derived env names from `preflightCore.mjs`.
- Correct nested `workflowRoles.<difficulty>.<role>` handling.
- Secret-safe summaries that print env var names only.
- `--non-interactive` mode for CI-style setup.
- Final validation through the repo’s `scripts/preflight.mjs`.

Test results:
- `node --check scripts/setup.mjs` passed.
- Isolated temp fixture smoke: ran `setup.mjs --non-interactive` twice.
  - First exit: `1`, expected because copied example placeholders fail preflight.
  - Second exit: `1`, expected for the same placeholder state.
  - `.env.local` and `assistant.config.local.json` were created.
  - Second run was idempotent: reported `Files written: none`.
  - Output did not print example placeholder values.

Changed files:
- [scripts/setup.mjs](C:/Users/24600/OneDrive/文档/Manager/scripts/setup.mjs:1)

## Execution Unit 06: Repo hygiene check (Part 5)

Implemented Task 06 only.

Added [scripts/repo-hygiene.mjs](E:/GameDeveloping/IReader/my-reader/scripts/repo-hygiene.mjs): pure ESM, no external deps, top comment with purpose/author, human and `--json` output, exit codes, git repo/dirty checks, `.gitignore` safeguard checks, `package-lock.json` check, and a soft version-bump warning against the latest exact `vX.Y.Z` tag. Since `scripts/lib/preflightCore.mjs` is not present in the current tree, `gitStatus` is implemented and exported locally in this script.

**Test Result**
- `node --check scripts/repo-hygiene.mjs` passed.
- Programmatic JSON checks passed for:
  - `node scripts/repo-hygiene.mjs --json`
  - `node scripts/repo-hygiene.mjs --bad --json`
- Both failure cases produced parseable JSON, empty stderr, and exit code `1` as expected.
- Current hygiene output fails as expected because the repo has 20 dirty/untracked files and `.gitignore` is missing literal `node_modules/`, `.env.local`, `.env`.

**Changed Files**
- `scripts/repo-hygiene.mjs` added.

Existing dirty files like `package.json` and the source/task files were left untouched.

## Execution Unit 07: Windows launchers (Part 3)

Implemented Task 07 only.

Changed files:
- [start-assistant.bat](</C:/Users/24600/OneDrive/文档/Manager/start-assistant.bat>)
- [start-assistant.ps1](</C:/Users/24600/OneDrive/文档/Manager/start-assistant.ps1>)

What changed:
- Added pure batch double-click launcher with `chcp 65001`, repo-root `cd /d "%~dp0"`, `where node`, `where npm`, and `call npm run assistant:start`.
- Added PowerShell launcher with `Set-Location -LiteralPath $PSScriptRoot`, `Get-Command` gates for Node/npm, colored stage output, error handling, and a final pause.

Test Result details:
- Passed: PowerShell syntax parse via `[scriptblock]::Create(...)`.
- Passed: BAT content markers for repo-root change, Node/npm gates, preflight banner, and `npm run assistant:start`.
- Passed: PS1 content markers for repo-root change, Node/npm gates, preflight banner, and assistant start command.
- Did not run the actual assistant startup, to avoid launching the runtime as part of this launcher-only unit.

## Execution Unit 08: Automated tests

Implemented Task 08 automated tests.

Added:
- [tests/preflight-core.test.ts](C:/Users/24600/OneDrive/文档/Manager/tests/preflight-core.test.ts)
- [tests/preflight.test.ts](C:/Users/24600/OneDrive/文档/Manager/tests/preflight.test.ts)
- [tests/repo-hygiene.test.ts](C:/Users/24600/OneDrive/文档/Manager/tests/repo-hygiene.test.ts)

Also fixed [package.json](C:/Users/24600/OneDrive/文档/Manager/package.json) JSON syntax so Vitest can load: `prepublishOnly` is now inside `scripts`. No dependency changes.

Test result:
- Command: `npx vitest run tests/preflight-core.test.ts tests/preflight.test.ts tests/repo-hygiene.test.ts --color=false`
- Result: `33 passed`, `2 failed`

Remaining failures are both intentional blockers exposed by the new tests:
- `node scripts/preflight.mjs --env-file <missing>` exits from Node itself with code `9` before `preflight.mjs` runs.
- JSON mode for the same case is not parseable because Node prints `node.exe: <file>: not found` to stderr.

This is due to Node 24 treating `--env-file` as a Node CLI flag unless invocation uses `node -- scripts/preflight.mjs ...`. I left the tests enforcing the approved plan behavior.

## Execution Unit 09: Docs & scripts convergence (Part 6)

Implemented Task 09 docs convergence.

Updated:
- [START_HERE.md](C:/Users/24600/OneDrive/文档/Manager/START_HERE.md:7): added setup wizard quick start, preflight/start commands, `--env-file` note, Windows launchers, and `assistant:hygiene`.
- [docs/agent-setup-guide.md](C:/Users/24600/OneDrive/文档/Manager/docs/agent-setup-guide.md:97): added setup/preflight usage, config-source rules, config-derived env-var contract, `workspace.targetDir` preflight rule, Windows launcher notes, and tightened project-path failure wording.

Validation:
- `git diff --check -- START_HERE.md docs/agent-setup-guide.md` passed.
- Confirmed new script/launcher files start with top-of-file comments.
- Focused tests run: `npm test -- tests/preflight-core.test.ts tests/preflight.test.ts tests/repo-hygiene.test.ts`
  - Result: failed, 33 passed / 2 failed.
  - Failures are existing preflight `--env-file` behavior in [tests/preflight.test.ts](C:/Users/24600/OneDrive/文档/Manager/tests/preflight.test.ts:278): missing env file exits `9` instead of `1`, and JSON mode writes a Node error to stderr. I did not patch that because this execution unit is docs-only.

Changed files in this execution unit:
- `START_HERE.md`
- `docs/agent-setup-guide.md`

## Final Review Follow-up (round 1)

Changed: no additional file edits were needed in this turn. The current tree already has the B1 fix in place: project-owned preflight invocations use `node -- scripts/preflight.mjs`, and the focused preflight tests spawn with the same separator.

Focused diagnostics I ran:
- Confirmed direct Node interception still reproduces without `--`: exit `9`.
- Confirmed `npm run assistant:preflight -- --env-file does-not-exist.env --json` reaches `preflight.mjs` and exits `1` with the named `env-file` failure.
- `npx vitest run tests/preflight.test.ts -t "env-file behavior" --color=false` passed: `3 passed`, `16 skipped`.
