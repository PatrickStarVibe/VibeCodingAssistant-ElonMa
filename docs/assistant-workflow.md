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

- `awaiting_difficulty_selection`: choose `low`, `medium`, `high`, or `extra high`.
- `ready_for_decision`: approve, revise, reject, restart, ask, status, or summary.
- `waiting_user_direction`: answer a product/scope question when Assistant Elon Ma explicitly needs one.
- `awaiting_user_acceptance`: accept, revise, or add a note.

## Difficulty

- `low`: planner creates the initial plan; review/revision is skipped.
- `medium`: planner creates the plan, reviewer reviews, planner revises.
- `high`: reviewer-side planning profile is used for riskier planning; planner-side profile reviews.
- `extra high`: uses the high role setup and adds up to 3 Planner <-> Reviewer plan-refinement rounds.

## Extra High Difficulty

`extra high` is for tasks where the plan quality matters enough to spend more planning budget. The first round asks Planner to produce a plan and Reviewer to review it. If Reviewer says there are no blocking issues, no issues, approved, looks good, or an equivalent approval, planning stops early.

If Reviewer finds issues, Assistant Elon Ma records revision instructions and sends the latest plan plus review back to Planner. The loop runs at most 3 rounds, then stops even if Reviewer still has concerns. In that cap case:

- `plan-rounds-log.md` contains every round's plan, review, verdict, and revision instructions.
- The final outstanding Reviewer concerns are copied into `plan-rounds-log.md`.
- `decision-log.md` records that the 3-round cap was hit.
- `revised-plan.md` starts with `> Note: Reviewer still flagged issues at round 3 - see plan-rounds-log.md.`

## Artifacts

- `original-task.md`: exact user prompt.
- `initial-plan.md`: first planner output.
- `review.md`: plan review when the difficulty uses one.
- `revision-instructions.md`: Assistant Elon Ma's planner-facing revision instructions when needed.
- `plan-rounds-log.md`: extra high planning-round transcript and any outstanding reviewer concerns.
- `revised-plan.md`: plan shown for approval.
- `assistant-explanation.md`: advisor explanation of the plan.
- `agent-prompts.md`: prompts sent to agents.
- `agent-prompt-preview.md`: on-demand preview of the planner prompt.
- `implementation-log.md`, `test-build-log.md`, `final-review.md`, `final-report.md`: execution and completion artifacts.

## Commands

- Create: `create task: <prompt>` or `/create <title>\n<prompt>`
- Pick difficulty: `low`, `medium`, `high`, or `extra high`
- Approve plan: `approve A`
- Revise plan: `revise C: <instruction>`
- Restart planning: `restart: <new prompt or direction>`
- Stop: `stop`
- Accept final result: `accept`
- Add acceptance note: `note: <note>`
- Show artifact: `/show <artifact-name>`

## Principle

Assistant Elon Ma can advise, explain, and route, but it no longer transforms the user's prompt into a separate requirement artifact before the planner sees it.
