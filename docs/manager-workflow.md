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
npm run manager -- reply --task latest "approve A"
```

`approve A` from the brief gate continues the pipeline:

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

If the brief misunderstood you, send `revise C: <correction>` and the Manager regenerates the brief, accumulating all your corrections across rounds. `reject B` from the brief gate stops the task.

Manager does not do a separate high-level review of the revised plan.

## Inspect State And Artifacts

```powershell
npm run manager -- status --task latest
npm run manager -- summary --task latest
npm run manager -- show --task latest --artifact revised-plan
npm run manager -- show --task latest --artifact review
npm run manager -- show --task latest --artifact final-report
```

Artifacts are stored under `logs/ai-workflow/runs/<task-id>/` in this Manager repo.

## Ask Questions Before Implementation

```powershell
npm run manager -- ask --task latest "Why is this approach better for latency?"
```

`ask` always uses the real Manager adapter. With the default DeepSeek Manager profile, `DEEPSEEK_API_KEY` must be set before the first Manager call.

## Reply Commands

Approve:

```powershell
npm run manager -- reply --task latest "approve A"
npm run manager -- reply --task latest "A"
npm run manager -- reply --task latest "yes"
npm run manager -- reply --task latest "同意"
```

Reject:

```powershell
npm run manager -- reply --task latest "reject B"
npm run manager -- reply --task latest "B"
```

Request changes:

```powershell
npm run manager -- reply --task latest "revise C: keep this as an MVP and avoid UI redesign"
```

Other local replies:

```powershell
npm run manager -- reply --task latest "status"
npm run manager -- reply --task latest "summary"
npm run manager -- reply --task latest "stop"
```

Difficulty replies are accepted only at `awaiting_difficulty_selection`:

```powershell
npm run manager -- reply --task latest "low"
npm run manager -- reply --task latest "medium"
npm run manager -- reply --task latest "high"
```

The first parser layer is a deterministic whitelist. If a reply is not whitelisted, Manager asks for confirmation and does not execute the interpreted action. Mixed replies such as `approve A but change the UX` are treated as ambiguous.

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
npm run manager -- reply --task latest "approve A" --allow-agent-calls
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

- `complete`: write final report.
- `route_to_implementer`: keep approval and route back to implementation.
- `route_to_planner`: request a new planning cycle.
- `ask_user_direction`: pause for a product, UX, cost, scope, or direction decision.

If Manager routes back to implementation, the task keeps its existing approval. Send `approve A` again to continue the already-approved implementation route.

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
