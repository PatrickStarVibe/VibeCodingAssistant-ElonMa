# Assistant Workflow

VibeCodingAssistant-ElonMa is now a thin workflow helper plus advisor.

The user prompt is the source of truth. VibeCodingAssistant-ElonMa does not rewrite it before planning.
Architect and Reviewer can directly request user decisions with a structured `assistant-user-decision` markdown block. VibeCodingAssistant-ElonMa parses that block, pauses, and forwards the options without rewriting them.

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
- `waiting_user_direction`: answer a product/scope question raised by Architect, Reviewer, VibeCodingAssistant-ElonMa, or the extra-high planning gate.
- `awaiting_user_acceptance`: accept, revise, or add a note.

## Difficulty

- `low`: planner creates the initial plan; review/revision is skipped.
- `medium`: planner creates the plan, reviewer reviews, planner revises.
- `high`: reviewer-side planning profile is used for riskier planning; planner-side profile reviews and must emit a blocker ledger. Architect revise must respond to every active blocker before the plan can enter normal approval.
- `extra high`: uses the high role setup plus up to 3 initial Architect <-> Reviewer refinement rounds. Reviewer closure of the blocker ledger, not approval prose, decides when planning is approved; if blockers remain, each additional round requires explicit user direction.

## Blocker Ledger

High and Extra High use a structured blocker ledger. Reviewer must include exactly one fenced `reviewer-blockers` JSON block. Architect revise must include exactly one fenced `architect-blocker-responses` JSON block whenever the ledger has active blockers.

VibeCodingAssistant-ElonMa does not judge whether a blocker is technically solved. It only parses, validates, records, and forwards the ledger. In High, Architect response coverage is enough to continue to `ready_for_decision`; the ledger may still show active blockers that have not had a second Reviewer closure pass. In Extra High, Reviewer must explicitly close every active blocker before planning is approved.

## Extra High Difficulty

`extra high` is for tasks where the plan quality matters enough to spend more planning budget. The first round asks Architect to produce a plan and Reviewer to review it with stable blocker IDs. If Reviewer emits an empty blocker ledger, planning stops early.

If Reviewer finds issues, Reviewer markdown and the active ledger are sent back to Architect as the authoritative revision input. The initial loop runs at most 3 rounds. If active blockers remain after that, the workflow pauses in `waiting_user_direction` instead of entering normal approval. The user can choose one more round, restart planning, or execute the current plan as an override. If one more round still has active blockers, the workflow asks again.

- `plan-rounds-log.md` contains every round's plan, review, verdict, and next-round directive.
- `blocker-ledger.md` contains the current blocker ledger with active and historical blockers.
- The final active blocker summary is copied into `plan-rounds-log.md`.
- `decision-log.md` records that Extra High planning paused with active blockers.
- `revised-plan.md` starts with a note that Extra High paused and points to `blocker-ledger.md`.

## Artifacts

- `original-task.md`: exact user prompt.
- `initial-plan.md`: first planner output.
- `review.md`: plan review when the difficulty uses one.
- `revision-instructions.md`: legacy VibeCodingAssistant-ElonMa planner-facing revision instructions. Standard planning no longer writes this artifact; Reviewer markdown is the authoritative input to Architect revise.
- `plan-rounds-log.md`: extra high planning-round transcript plus blocker ledger snapshots.
- `blocker-ledger.md`: current High / Extra High blocker ledger, including Reviewer verdicts and Architect responses.
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

VibeCodingAssistant-ElonMa can advise, explain, and route, but it no longer transforms the user's prompt into a separate requirement artifact before the planner sees it.
VibeCodingAssistant-ElonMa does not infer user decisions from ordinary prose. The formal planning decision protocol is a fenced `assistant-user-decision` JSON block; explicit unstructured decision markers without that block are treated as invalid agent output and pause the workflow.
