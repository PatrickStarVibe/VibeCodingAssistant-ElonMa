# Manager Beginner Setup Guide

This guide is for users who are new to command-line setup. It explains what to edit, what each file means, and how to check that Manager can see your own project.

If you already know how to configure local developer tools, use the shorter [START_HERE.md](START_HERE.md). If you want an AI coding agent to do the setup for you, give it [docs/agent-setup-guide.md](docs/agent-setup-guide.md).

## What This Project Is

Manager is the local workflow repo for Assistant Elon Ma. It helps you run a structured AI coding workflow around your own project:

- You tell Assistant Elon Ma what you want changed.
- Manager creates a task record and routes planning, implementation, review, and final acceptance.
- Manager can send prompts to your configured LLM provider or local coding-agent command.
- Manager can optionally connect to Lark / Feishu so you can drive the workflow from chat.

Manager is not the project you want to edit. Manager needs to know the path to that project, then it can pass the right workspace and project-memory files to the agents.

## What You Need Before Setup

Prepare these items first:

- Node.js and npm installed on your computer.
- This Manager repo downloaded locally.
- The local path of the project you want Manager to operate on, for example `<YOUR_PROJECT_PATH>`.
- A provider account, API key, or local provider command for your AI workflow.
- The environment variable names you want to use for secrets, for example `<YOUR_API_KEY_ENV>`.
- Optional: Lark / Feishu app credentials if you want to use the Lark bridge.
- Optional: your Lark open ID and any control chat IDs.

Do not paste real API keys into docs, chat messages, screenshots, or committed files. Real secrets belong only in `.env.local` or your system environment variables.

## Open A Terminal In The Manager Folder

On Windows, open File Explorer, go to the Manager folder, click the address bar, type `powershell`, then press Enter.

You should now see a PowerShell window opened in the Manager folder. All commands below assume that window is already in the Manager folder.

Check that Node and npm are installed:

```powershell
node -v
npm -v
```

If either command says it is not recognized, install Node.js, close PowerShell, open it again in the Manager folder, and retry the two commands.

Install project dependencies if `node_modules` is missing or you just downloaded the repo:

```powershell
npm install
```

## Copy The Local Config Files

Manager keeps shareable examples separate from your private local setup:

- `.env.example` is the safe example for environment variables.
- `assistant.config.example.json` is the safe example for Manager configuration.
- `.env.local` is your private secret file.
- `assistant.config.local.json` is your private local Manager config.
- `assistant.projects.local.json` is an optional private place to add project entries.

Create local copies:

```powershell
Copy-Item .\assistant.config.example.json .\assistant.config.local.json
Copy-Item .\.env.example .\.env.local
```

If PowerShell asks whether to overwrite a file, stop and check whether you already configured Manager before replacing it.

## Fill In `.env.local`

Open `.env.local` with a text editor. This file stores secret values or local-only credentials.

The names on the left side must match the names used in `assistant.config.local.json`. The values on the right side are your real local values.

Example shape:

```dotenv
<YOUR_API_KEY_ENV>=<YOUR_API_KEY>
<YOUR_LARK_APP_ID_ENV>=<YOUR_LARK_APP_ID>
<YOUR_LARK_APP_SECRET_ENV>=<YOUR_LARK_APP_SECRET>
```

For example, if `assistant.config.local.json` says:

```json
"apiKeyEnv": "ASSISTANT_API_KEY"
```

then `.env.local` needs a matching line:

```dotenv
ASSISTANT_API_KEY=replace_this_with_your_real_key
```

Keep these rules:

- Do not rename env vars in `.env.local` unless you also update the config field that references them.
- Do not put quotes around normal values unless your provider specifically requires them.
- Do not commit `.env.local`.
- Do not ask an AI agent to print the real values back to you.

If your provider works through a local command instead of an API key, keep any secrets required by that command in `.env.local` or your system environment. Put only the command name or command path in the Manager profile.

## Fill In Your Project Path

Open `assistant.config.local.json`. The most important project fields are:

- `workspace.targetDir`: the default project folder Manager should use.
- `defaultProjectId`: the project id Manager uses when no project is specified.
- `projects[]`: the list of projects Manager can operate on.
- `projects[].targetDir`: the real local path of one project.
- `projects[].docsDir`: the project-memory folder for Manager to read.
- `projects[].taskRecordRoot`: where task records should be written.
- `projects[].alwaysRead`: Markdown files inside `docsDir` that should always be loaded.

Use placeholders like this while editing:

```json
{
  "workspace": {
    "targetDir": "<YOUR_PROJECT_PATH>"
  },
  "defaultProjectId": "<PROJECT_ID>",
  "projects": [
    {
      "id": "<PROJECT_ID>",
      "name": "<PROJECT_NAME>",
      "targetDir": "<YOUR_PROJECT_PATH>",
      "docsDir": "project-docs/<PROJECT_ID>",
      "taskRecordRoot": "<YOUR_PROJECT_PATH>/task",
      "alwaysRead": []
    }
  ]
}
```

Replace:

- `<PROJECT_ID>` with a short id such as `my-app`.
- `<PROJECT_NAME>` with a human-readable name.
- `<YOUR_PROJECT_PATH>` with the folder path of the project you want Manager to edit.

Windows paths can use either forward slashes or escaped backslashes:

```json
"targetDir": "C:/Users/you/projects/my-app"
```

or:

```json
"targetDir": "C:\\Users\\you\\projects\\my-app"
```

If you do not want to edit the main config file for projects, add project entries to `assistant.projects.local.json` instead:

```json
{
  "projects": [
    {
      "id": "<PROJECT_ID>",
      "name": "<PROJECT_NAME>",
      "targetDir": "<YOUR_PROJECT_PATH>",
      "docsDir": "project-docs/<PROJECT_ID>",
      "alwaysRead": []
    }
  ]
}
```

## Fill In Provider Profiles

In `assistant.config.local.json`, `profiles` describes how Manager reaches each LLM provider or coding agent. `workflowRoles` tells Manager which profile to use for each role.

API-backed profile shape:

```json
{
  "kind": "openai-compatible",
  "provider": "<YOUR_PROVIDER_NAME>",
  "model": "<YOUR_MODEL_NAME>",
  "baseUrl": "<YOUR_PROVIDER_BASE_URL>",
  "apiKeyEnv": "<YOUR_API_KEY_ENV>"
}
```

Command-backed profile shape:

```json
{
  "kind": "command",
  "provider": "<YOUR_PROVIDER_NAME>",
  "command": "<YOUR_PROVIDER_COMMAND>"
}
```

Keep this provider-agnostic:

- Use the model, endpoint, env var names, and command from your chosen provider.
- Do not hard-code one provider into every profile unless you really want all roles to use it.
- Make sure every name in `workflowRoles` exists under `profiles`.

## Verify Manager Can Read Your Project

First list configured projects:

```powershell
npm run assistant -- projects --config assistant.config.local.json
```

You want to see your `<PROJECT_ID>` and `<YOUR_PROJECT_PATH>` in the output. If you do, Manager can load the project entry.

Next create a tiny smoke task:

```powershell
npm run assistant -- create --config assistant.config.local.json --project <PROJECT_ID> --title "setup-smoke-test" --task "Check whether this Manager setup can read the configured project root and project docs."
```

The command returns a task id. Use that id in the next commands:

```powershell
npm run assistant -- plan --config assistant.config.local.json --task <TASK_ID>
npm run assistant -- show --config assistant.config.local.json --task <TASK_ID> --artifact agent-prompt-preview
```

In the preview, check that `Target workspace` points to your project path, not the Manager repo path unless Manager itself is the project you are testing.

When the task asks for difficulty, reply with one of `low`, `medium`, or `high`:

```powershell
npm run assistant -- reply --config assistant.config.local.json --task <TASK_ID> "low"
```

For a setup smoke test, `low` is usually enough.

## Start The Lark Bridge

Use this only if you want to control Assistant Elon Ma from Lark / Feishu.

Before starting, confirm:

- `.env.local` has the env vars referenced by `lark.appIdEnv` and `lark.appSecretEnv`.
- `assistant.config.local.json` has your open ID in `lark.allowedOpenIds`.
- Optional `lark.controlChatIds` is empty or contains the chat IDs allowed to create tasks.
- Your provider profile for the assistant chat role has the needed API key or command setup.

Start the bridge:

```powershell
npm run assistant:lark -- --config assistant.config.local.json
```

For a safer routing smoke test that avoids calling heavy workflow agents:

```powershell
npm run assistant:lark -- --config assistant.config.local.json --stub-heavy-agents
```

More detail is in [docs/lark-bridge.md](docs/lark-bridge.md).

## Common Errors

`node` or `npm` is not recognized:
Install Node.js, close and reopen PowerShell, then run `node -v` and `npm -v` again.

`config missing` or Manager cannot find `assistant.config.local.json`:
Copy `assistant.config.example.json` to `assistant.config.local.json`, or pass the correct path with `--config assistant.config.local.json`.

`missing API key`:
Check that `.env.local` exists, the variable name matches `profiles.<profile>.apiKeyEnv`, and the value is not empty. Do not print the real key while debugging.

`project path invalid`:
Check that `workspace.targetDir` and every `projects[].targetDir` points to a real folder on this computer. If the path contains backslashes in JSON, write each backslash as `\\`.

`provider command not found`:
Check the command-backed profile's `command`. The command must exist in the current PowerShell `PATH`, or you must use the full path to the executable.

`Lark credentials missing`:
Check that `lark.appIdEnv` and `lark.appSecretEnv` name variables that exist in `.env.local` or your system environment. Also confirm the Lark app has bot/message permissions enabled.

`Lark message ignored`:
Check that the sender open ID is in `lark.allowedOpenIds`. If `lark.controlChatIds` is not empty, check that the chat ID is allowed for task creation.

## If You Want An AI Agent To Configure This

Give the agent [docs/agent-setup-guide.md](docs/agent-setup-guide.md), then provide only the information it asks for. Do not paste real secret values into chat unless you trust the tool and understand where the transcript is stored.

The agent should edit only local files:

- `.env.local`
- `assistant.config.local.json`
- `assistant.projects.local.json`

After setup, ask it to run:

```powershell
npm run assistant -- projects --config assistant.config.local.json
npm run build
npm test
```

For the full reference flow, see [START_HERE.md](START_HERE.md). For a short project overview, see [README.md](README.md).
