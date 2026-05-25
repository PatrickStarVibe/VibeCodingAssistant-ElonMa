# Codex Handoff

This repository's assistant flow has been simplified.

## Current Contract

The original user prompt is authoritative. Do not add a pre-planning rewrite step.

The first workflow stop is difficulty selection:

```text
created -> awaiting_difficulty_selection
```

After the user chooses `low`, `medium`, or `high`, planning starts.

## Recommended Local Flow

```powershell
npm run assistant -- create
npm run assistant -- reply low
npm run assistant -- show --task latest --artifact revised-plan
npm run assistant -- reply "approve A"
```

For task-chat or Lark usage, the same flow is:

```text
create task: <prompt>
low | medium | high
approve A
accept
```

## Statuses To Treat As User Gates

- `awaiting_difficulty_selection`
- `ready_for_decision`
- `waiting_user_direction`
- `awaiting_user_acceptance`

## Planner Input

Planner prompts must include the exact original prompt and treat it as the source of truth.

When additional user instructions arrive through `revise C` or `restart:`, append them to `requestedChanges` and give them priority over earlier planner output.

## Do Not Reintroduce

- A pre-planning summary confirmation step.
- A separate requirement artifact that outranks the user prompt.
- Any legacy state or artifact names from the removed flow.
