# AI Agent Setup Guide

Use this guide when a coding agent is asked to configure VibeCodingAssistant-ElonMa for a user's local VibeCodingAssistant-ElonMa workflow.

This guide is intentionally provider-agnostic. Do not assume a specific LLM provider, model, API endpoint, or coding-agent CLI unless the user gives that information.

## Files To Read First

Read these files before editing anything:

- [../README.md](../README.md)
- [../START_HERE.md](../START_HERE.md)
- [../START_HERE_FOR_BEGINNERS.md](../START_HERE_FOR_BEGINNERS.md)
- [../.env.example](../.env.example)
- [../assistant.config.example.json](../assistant.config.example.json)
- [lark-bridge.md](lark-bridge.md)

Also inspect existing local config files if they exist, but do not print real secret values:

- `assistant.config.local.json`
- `assistant.projects.local.json`
- `.env.local` existence only, plus required env var names only.

For `.env.local`, the agent may check whether the file exists and whether required env var names are present. The agent must not read env var values unless the user gives explicit in-conversation permission, and values must never be written to logs, task records, docs, examples, screenshots, commits, or final messages.

## Information To Ask The User For

Ask for only the missing setup details. Do not ask the user to reveal real secret values unless they explicitly want you to place them in `.env.local`.

Project details:

- Project id, for example `<PROJECT_ID>`.
- Project display name.
- Project local path, for example `<YOUR_PROJECT_PATH>`.
- Project docs path, usually `project-docs/<PROJECT_ID>`.
- Optional task record root.
- Optional always-read Markdown files under the docs path.

Provider/profile details:

- Which profiles are API-backed and which are command-backed.
- Provider label for each profile.
- Model name and base URL for API-backed profiles.
- API key environment variable names, not the key values.
- Command for command-backed profiles.
- `workflowRoles.assistant` profile name.
- Low, medium, and high role mappings for `architect`, `planReviewer`, `developer`, and `finalReviewer`.

Lark / Feishu bridge details, if the user wants bridge setup:

- Env var name for app id.
- Env var name for app secret.
- Allowed user open IDs.
- Optional task member open IDs.
- Optional control chat IDs.
- Whether to test with `--stub-heavy-agents`.

## Editable Files

Only edit local setup files:

- `.env.local`
- `assistant.config.local.json`
- `assistant.projects.local.json`

You may create these files from examples if they do not exist. Do not edit provider-agnostic examples to contain the user's private setup.

For this documentation task only, docs and cross-links may be edited. For user setup tasks, stay within the three local files above unless the user explicitly asks for a repo documentation change.

## Forbidden Behavior

Do not:

- Read aloud, print, summarize, or commit real API keys, app secrets, tokens, or credentials.
- Copy real secrets into task records, logs, docs, examples, screenshots, or final messages.
- Persist secrets anywhere except `.env.local` or the user's system environment.
- Replace placeholder examples with one provider-specific setup.
- Hard-code one LLM provider into all docs or profiles unless the user asks for that exact local setup.
- Revert unrelated user changes while editing local config.

When you need to confirm `.env.local`, report only non-secret facts:

- Whether `.env.local` exists.
- Whether each required env var name exists, without reading or reporting its value.
- Reading any env value requires the user's explicit in-conversation permission.

## Setup Workflow

1. Confirm the VibeCodingAssistant-ElonMa repo root and whether local config files already exist.
2. If needed, copy `.env.example` to `.env.local` and `assistant.config.example.json` to `assistant.config.local.json`.
3. Fill `workspace.targetDir`, `defaultProjectId`, and `projects[]` or `assistant.projects.local.json`.
4. Fill `profiles` and `workflowRoles` using the user's provider/profile details.
5. Fill `lark.appIdEnv`, `lark.appSecretEnv`, `allowedOpenIds`, `taskMemberOpenIds`, and `controlChatIds` only if the user wants Lark setup.
6. Ensure every `apiKeyEnv`, `appIdEnv`, and `appSecretEnv` name has a corresponding variable in `.env.local` or the system environment.
7. Validate without printing secrets.

The supported first-run path is the setup wizard:

```powershell
npm run assistant:setup
```

For CI or scripted smoke checks, `npm run assistant:setup -- --non-interactive` copies missing example files and runs preflight without prompts. It is expected to fail until placeholders and local-only values are replaced.

## Validation Commands

Run these from the VibeCodingAssistant-ElonMa repo root:

```powershell
npm run assistant:preflight
npm run assistant -- projects --config assistant.config.local.json
npm run build
npm test
```

Expected non-secret checks:

- `npm run assistant:preflight` checks Node.js, config source, config-derived env var names, workspace/project paths, Lark allowlists, command-backed profiles, and `npmScript` references.
- The `projects` command lists the expected project id and target path.
- `npm run build` exits successfully.
- `npm test` exits successfully.
- No command output contains real API keys, app secrets, or tokens.

Useful validation variants:

```powershell
npm run assistant:doctor
npm run assistant:hygiene
npm run assistant:preflight -- --json
npm run assistant:preflight -- --env-file <PATH_TO_ENV_FILE>
```

Preflight config source rules:

- Default preflight requires `assistant.config.local.json`.
- If only `assistant.config.example.json` exists, default preflight fails and tells the user to run `npm run assistant:setup`.
- `--config <path>` explicitly validates that file; a missing explicit path is a failure.
- If neither local nor example config exists, preflight fails with a config-source error.

Preflight derives required env var names from config. It checks `profiles.<name>.apiKeyEnv` for API-backed profiles used by workflow roles and `lark.appIdEnv` / `lark.appSecretEnv` when Lark is configured. It does not hard-require old names such as `MANAGER_API_KEY` or `MANAGER_AGENT_ID` unless the user's config explicitly names them.

For `.env.local`, follow the three-bullet rule above: check only whether the file exists, whether each required env var name exists, and do not read values without explicit in-conversation permission. Preflight may report missing or placeholder values by env var name, but it must never echo the values.

`--env-file <path>` validates the named file for preflight, but the runtime still loads `.env.local` when the assistant starts. If a non-default env file passes preflight, copy the same non-secret env var names into `.env.local` or confirm with the user before launch.

Preflight is intentionally stricter than the runtime for workspace paths. It does not silently substitute any machine-local runtime default for `workspace.targetDir`. A missing, blank, or placeholder `workspace.targetDir`, a missing/placeholder `projects[].targetDir`, or a `defaultProjectId` that does not match a project blocks launch. This is the supported way to avoid accidentally using a developer machine path after cloning the repo.

Windows launchers:

- `start-assistant.bat` is the double-click batch entry point.
- `start-assistant.ps1` is the PowerShell entry point.
- Both check Node.js/npm and then call `npm run assistant:start`; `assistant:start` runs preflight before the Lark bridge starts.

Optional smoke task:

```powershell
npm run assistant -- create --config assistant.config.local.json --project <PROJECT_ID> --title "setup-smoke-test" --task "Check whether this VibeCodingAssistant-ElonMa setup can read the configured project root and project docs."
npm run assistant -- plan --config assistant.config.local.json --task <TASK_ID>
npm run assistant -- show --config assistant.config.local.json --task <TASK_ID> --artifact agent-prompt-preview
```

Check that `agent-prompt-preview` shows the intended `Target workspace`.

Optional Lark bridge smoke test:

```powershell
npm run assistant:lark -- --config assistant.config.local.json --stub-heavy-agents
```

If this fails, check only env var presence, allowed open IDs, bridge permissions, and provider profile shape. Do not print secret values while debugging.

## Common Setup Failures

`missing API key`:
The env var named by `profiles.<profile>.apiKeyEnv` is missing or empty. Add the value to `.env.local` or the system environment without printing it.

`config missing`:
The local config file was not created or the command points at the wrong path. Create `assistant.config.local.json` from the example or pass `--config assistant.config.local.json`.

`project path invalid`:
The path in `workspace.targetDir` or `projects[].targetDir` is missing, still a placeholder, or does not exist on this machine. Ask the user for the correct local folder; do not rely on runtime defaults.

`provider command not found`:
The command-backed profile's `command` is not available in the current shell. Ask for the installed command, full executable path, or setup instructions for that provider.

`Lark credentials missing`:
The env var names in `lark.appIdEnv` or `lark.appSecretEnv` do not exist or are empty. Add values locally without exposing them.

`Node/npm missing`:
`node -v` or `npm -v` fails. Ask the user to install Node.js, reopen the shell, and rerun validation.

## Final Report To User

Report:

- Which local files changed.
- Which project ids were configured.
- Which validation commands passed or failed.
- Any remaining information needed from the user.

Do not include real secret values in the report.
