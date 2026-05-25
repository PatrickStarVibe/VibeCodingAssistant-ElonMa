# Assistant Workflow

Assistant Elon Ma is now a thin workflow helper plus advisor.

The user prompt is the source of truth. Assistant Elon Ma does not rewrite it before planning.

## Flow

```text
user prompt
  -> created
  -> awaiting_difficulty_selection
  -> planning
  -> ready_for_decision
  -> implementation_approved
  -> implementing
  -> final_reviewing
  -> awaiting_user_acceptance
  -> completed
```

## User Gates

- `awaiting_difficulty_selection`: choose `low`, `medium`, or `high`.
- `ready_for_decision`: approve, revise, reject, restart, ask, status, or summary.
- `waiting_user_direction`: answer a product/scope question when Assistant Elon Ma explicitly needs one.
- `awaiting_user_acceptance`: accept, revise, or add a note.

## Difficulty

- `low`: planner creates the initial plan; review/revision is skipped.
- `medium`: planner creates the plan, reviewer reviews, planner revises.
- `high`: reviewer-side planning profile is used for riskier planning; planner-side profile reviews.

## Artifacts

- `original-task.md`: exact user prompt.
- `initial-plan.md`: first planner output.
- `review.md`: plan review when the difficulty uses one.
- `revision-instructions.md`: Assistant Elon Ma's planner-facing revision instructions when needed.
- `revised-plan.md`: plan shown for approval.
- `assistant-explanation.md`: advisor explanation of the plan.
- `agent-prompts.md`: prompts sent to agents.
- `agent-prompt-preview.md`: on-demand preview of the planner prompt.
- `implementation-log.md`, `test-build-log.md`, `final-review.md`, `final-report.md`: execution and completion artifacts.

## Commands

- Create: `create task: <prompt>` or `/create <title>\n<prompt>`
- Pick difficulty: `low`, `medium`, or `high`
- Approve plan: `approve A`
- Revise plan: `revise C: <instruction>`
- Restart planning: `restart: <new prompt or direction>`
- Stop: `stop`
- Accept final result: `accept`
- Add acceptance note: `note: <note>`
- Show artifact: `/show <artifact-name>`

## Principle

Assistant Elon Ma can advise, explain, and route, but it no longer transforms the user's prompt into a separate requirement artifact before the planner sees it.
