# Manager AI Coding Workflow

Manager is a standalone local development orchestrator. It lives in this repo and controls a separate target workspace through configuration. No Manager code is installed into the target project.

## Setup

1. Install dependencies:

```powershell
npm install
```

2. Create a local config:

```powershell
Copy-Item manager.config.example.json manager.config.local.json
```

3. Edit `manager.config.local.json`:

```json
{
  "workspace": {
    "targetDir": "E:/GameDeveloping/IReader/my-reader"
  }
}
```

`manager.config.local.json` is ignored by git.

## Create And Run A Task

Create a task:

```powershell
npm run manager -- create --title "Reader hover fix" --task "Describe the product task here."
```

Run planning through the default stopping point:

```powershell
npm run manager -- plan --task latest
```

This runs:

```text
task -> Manager brief -> awaiting_brief_confirmation
```

The first `plan` invocation stops at the brief gate. You confirm or correct the brief BEFORE any heavy agent (Codex/Claude) is called. This catches voice-input errors and aligns intent before burning tokens.

```powershell
npm run manager -- show --task latest --artifact manager-brief
```

In Lark, say `同意` to continue from the brief gate. In the CLI developer surface, send the equivalent exact reply command.

```text
-> awaiting_difficulty_selection
```

Pick one difficulty:

```powershell
npm run manager -- reply --task latest "medium"
```

After difficulty selection, the planning pipeline continues:

```text
-> initial plan -> optional plan review/revision -> Manager explanation -> ready_for_decision
```

If the brief misunderstood you, say what needs to change and the Manager regenerates the brief, accumulating all your corrections across rounds. If the task should not continue, say that clearly and the state machine stops it only from a legal gate.

Manager does not do a separate high-level review of the revised plan.

## Conversation Layer Boundary

Manager now keeps the workflow state machine and the chat layer separate:

- The workflow state machine owns correctness. It decides which transitions are legal and keeps the gates intact: brief confirmation, difficulty selection, plan approval, final review routing, and user acceptance.
- The Lark conversation layer owns semantic understanding and voice. Each task-chat message is classified by the Manager LLM against the actions allowed by the current state, then the raw workflow result is composed into short Chinese-first chat text.

In Lark, users can reply naturally: `同意`, `走高难度`, `这个方案风险最大在哪里？`, `这里先别扩大范围`, or `验收通过`. The state machine still rejects unsafe jumps; if the current stage is not waiting for approval, an approval-like message will not start implementation.

## Inspect State And Artifacts

```powershell
npm run manager -- status --task latest
npm run manager -- summary --task latest
npm run manager -- show --task latest --artifact revised-plan
npm run manager -- show --task latest --artifact review
npm run manager -- show --task latest --artifact final-report
```

Artifacts are stored under `logs/ai-workflow/runs/<task-id>/` in this Manager repo.

## Target Project Task Records

Manager also writes human-facing task documentation into the target project task record root.

`TASK_RECORD_ROOT` is configurable per project with `taskRecordRoot`. If it is not configured, Manager uses:

```text
<project.targetDir>/task
```

For IReader, that resolves to:

```text
E:/GameDeveloping/IReader/my-reader/task
```

Every workflow task gets one parent folder:

```text
task/<task-id>/
  README.md
  brief.md
  plan.md
  plan-review.md
  implementation-log.md
  final-review.md
  task-record.md
  subtasks/
  artifacts/
```

A single task is one execution unit:

```text
task/<task-id>/subtasks/01-main.md
```

A decomposed task uses the same parent folder with multiple execution units:

```text
task/<task-id>/subtasks/01-*.md
task/<task-id>/subtasks/02-*.md
```

Do not place subtask markdown files directly under `task/`.

The global `task/README.md` uses:

```text
| Task | Category | Status | Execution Mode | Summary | Updated |
```

Category is one metadata field only. Supported values are `Reader Core`, `Selection / Popup`, `Vocabulary Algorithm`, `Translation / LLM`, `Feedback / User Model`, `Storage / Persistence`, `Backend / API`, `Data / Dictionary Pipeline`, `Evaluation / Benchmark`, `Manager / Workflow`, `Docs / Task Record`, `UI / Frontend`, and `Other`. Missing or unknown values become `Other`. Category never creates folders, changes execution behavior, or changes review policy.

Lifecycle timing:

- task creation initializes the parent folder with placeholder files;
- brief generation fills `brief.md`;
- user-approved plans fill `plan.md`, `plan-review.md`, and `subtasks/*.md`;
- execution updates `implementation-log.md` and each subtask `Test Result`;
- final review updates `final-review.md`;
- user acceptance finalizes `task-record.md`;
- `completed` is blocked until `task-record.md` is valid.

## Ask Questions Before Implementation

```powershell
npm run manager -- ask --task latest "Why is this approach better for latency?"
```

`ask` always uses the real Manager adapter. With the default DeepSeek Manager profile, `DEEPSEEK_API_KEY` must be set before the first Manager call.

## Reply Surfaces

Lark task chats are the user-facing reply surface. Mentioning the bot is optional; `@bot 同意` and `同意` are treated the same. The bridge strips Lark mention tokens before classification, asks DeepSeek for intent, checks the intent against the current workflow gate, executes only legal transitions, and then rewrites the raw result without dumping `Task ID / Status / Pending` blocks.

The local CLI remains a developer/debug surface. `npm run manager -- reply` sends exact text directly to the workflow service, which is useful for repeatable smoke tests and scripted runs. Natural-language intent classification happens in the Lark bridge, not in the CLI.

## Difficulty Levels

Choose `low` for tiny copy, color, or configuration changes. Manager calls the Architect once, copies the initial plan to the revised-plan artifact, skips plan review and revision instructions, then explains the plan. By default Codex fills Architect, Developer, and Final Reviewer.

Choose `medium` for normal feature work. This is the original flow: Codex fills Architect and Developer, while Claude fills Plan Reviewer and Final Reviewer.

Choose `high` for risky or complex work. Claude fills Architect, Plan Reviewer, and Final Reviewer, while Codex fills Developer.

## Agent Calls

Manager is always real in product use. The default Manager profile is DeepSeek and uses `DEEPSEEK_API_KEY`.

Architect, Plan Reviewer, Developer, and Final Reviewer default to stub adapters unless agent calls are enabled. They produce inspectable placeholder artifacts and do not call external tools.

To call the configured heavy agents:

```powershell
npm run manager -- plan --task latest --allow-agent-calls
npm run manager -- reply --task latest "medium" --allow-agent-calls
```

## Configure And Swap Roles

Profiles are mapped by fixed workflow role in `manager.config.local.json`. `roles.manager` chooses the Manager agent. `workflowRoles` chooses the heavy-agent profile for each difficulty and role:

```json
{
  "roles": {
    "manager": "deepseek-manager"
  },
  "workflowRoles": {
    "low": {
      "architect": "codex-architect",
      "planReviewer": "codex-plan-reviewer",
      "developer": "codex-developer",
      "finalReviewer": "codex-final-reviewer"
    },
    "medium": {
      "architect": "codex-architect",
      "planReviewer": "claude-plan-reviewer",
      "developer": "codex-developer",
      "finalReviewer": "claude-final-reviewer"
    },
    "high": {
      "architect": "claude-architect",
      "planReviewer": "claude-plan-reviewer",
      "developer": "codex-developer",
      "finalReviewer": "claude-final-reviewer"
    }
  }
}
```

To swap Codex, Claude, or future API-backed agents later, add or edit `profiles` and point the relevant `workflowRoles.<difficulty>.<role>` entry at the desired profile name. The role meaning stays fixed; only the backing profile changes.

## Verification Allowlist

Planner-proposed verification commands are not executed freely. They must exactly match the configured allowlist after whitespace normalization.

Default allowed commands:

```text
npm test
npm run test
npm run build
npm run lint
tsc --noEmit
npx tsc --noEmit
```

Add project-specific commands in `manager.config.local.json`:

```json
{
  "verification": {
    "allowlist": ["npm test", "npm run test:workflow"]
  }
}
```

Blocked commands are recorded in the test/build artifact.

## Final Review Routing

Final review is not the endpoint. Manager routes the result to one of:

- `complete`: pause at user acceptance before writing the task record and final report.
- `route_to_implementer`: keep approval and route back to implementation.
- `route_to_planner`: request a new planning cycle.
- `ask_user_direction`: pause for a product, UX, cost, scope, or direction decision.

If Manager routes back to implementation, the task keeps its existing approval. Send a natural approval in Lark, or the equivalent exact CLI reply, to continue the already-approved implementation route.

If Manager routes to `complete`, the task is not completed immediately. It moves to `awaiting_user_acceptance`.

From `awaiting_user_acceptance`, Lark users can reply naturally:

- `验收通过` finalizes `task-record.md`, writes the final report, and marks the task completed.
- `补充备注：...` records an acceptance note and keeps waiting.
- `这里还要改：...` routes the task back for changes.

The final report separates:

- `本次 implementation 产生的 diff`
- `pre-existing dirty`

For files that were already dirty before implementation and changed again, compare `git-pre-diff` and `git-post-diff`.

## Lark Bridge

A message integration should not duplicate workflow logic. The Lark bridge keeps Manager as the workflow owner and turns Lark into the chat surface:

- `npm run manager:lark` starts the long-connection bot.
- `/pair <code>` lets Manager learn the user's Lark `open_id`.
- A new task request creates a Manager task and a task-specific Lark chat.
- Task-chat messages route to the explicit task ID, never `latest`.
- Briefs, revised plans, explanations, and final reports are sent back as Markdown artifacts.

See [lark-bridge.md](lark-bridge.md) for setup and daily use.

## Token Usage Ledgers

Manager creates `token-usage.json` in every new task record folder. This file is machine-readable and is the source of truth when the user asks how many tokens or how much money a task used.

- `entries[]` records usage by `role`, `subtaskId`, and `stepId`.
- `accuracy` must be `actual`, `estimated`, or `unknown`.
- Use `actual` only when platform/API usage is exposed.
- Use `estimated` only when a documented estimate or price snapshot was used.
- Use `unknown` when usage is not exposed; do not invent backfill numbers.

Useful commands:

```powershell
npm run manager -- usage --task latest
npm run manager -- usage --task latest --by role
npm run task-usage:summarize -- --task task/<task-id> --by subtask
npm run task-usage:summarize -- --latest --by step
```
