# Lark Transport

The Lark layer is now a thin transport for Elon Ma.

It keeps only:

- `allowedOpenIds` authorization
- event id dedupe
- text/file sending
- task chat creation when Elon Ma calls the tool
- minimal inbound/outbound audit logs

It does not parse `low`, `approve`, `status`, `summary`, or normal chat text by itself. Authorized messages go to the configured Assistant Elon Ma chat profile, which either replies naturally or calls a workflow tool.

## Setup

1. Create a Lark self-built app with bot and message events.
2. Grant receive-message, send-message, create-chat, and file-upload permissions.
3. Put your Lark `open_id` in `assistant.config.local.json`:

```json
"allowedOpenIds": ["ou_your_open_id_here"]
```

4. Configure local-only secrets in `.env.local`, `assistant.config.local.json`, or your shell environment. `assistant.config.example.json` shows the required shape:

```json
"profiles": {
  "assistant-api": {
    "kind": "openai-compatible",
    "provider": "your-chat-provider",
    "model": "your-chat-model",
    "baseUrl": "https://api.your-provider.example/v1",
    "apiKeyEnv": "ASSISTANT_API_KEY"
  }
}
```

The assistant chat profile uses an OpenAI-compatible `/chat/completions` endpoint. Set `baseUrl`, `model`, and `apiKeyEnv` for your provider. For command-backed workflow roles, set an explicit `command`; Manager does not assume a default CLI. Existing shell environment variables take precedence over values in `.env.local`.

5. Set local environment variables or put the same names in `.env.local`:

```powershell
$env:LARK_APP_ID="cli_xxx"
$env:LARK_APP_SECRET="xxx"
$env:ASSISTANT_API_KEY="sk_xxx"
```

6. Start the transport:

```powershell
npm run assistant:lark
```

For local smoke tests without heavy agent calls:

```powershell
npm run assistant:lark -- --stub-heavy-agents
```

## Removed

- No `/pair`
- No pending proposal flow
- No task draft confirmation
- No watcher idle reminders
- No bridge-level difficulty/approve/status parser
- No bridge-level running-job message block

`controlChatIds` only limits which chats may create new tasks. It does not change conversation semantics.

## Tool Calling

Elon Ma can call these tools:

- `reply_to_user(text)`
- `create_task(prompt, title?, projectId?)`
- `choose_difficulty(taskId?, difficulty, instruction?)`
- `approve_plan(taskId?, instruction?)`
- `revise_plan(taskId?, instruction)`
- `stop_task(taskId?, reason?)`
- `ask_task_question(taskId?, question)`
- `show_status(taskId?)`
- `show_artifact(taskId?, artifact)`
- `switch_project(projectId)`
- `create_new_task_from_task_chat(prompt, title?, projectId?)`

If a tool is not valid for the current workflow state, the tool layer returns the error to Elon Ma so it can explain in normal language.

Only an obvious stop/cancel message is allowed to bypass the assistant chat profile, so the transport can stop a bound task immediately.

## State

`logs/ai-workflow/lark-bridge-state.json` now stores only:

- `activeProjectIdByChatId`
- `bindingsByChatId`
- `runningJobsByTaskId`
- `processedEventIds`

Old fields such as pairing codes, paired users, proposals, and reminder hashes are ignored on load and dropped on the next save.
