All sites are wired up correctly. Tests and build pass on rerun (172 tests, all green). Final review summary:

## Final Review

**Verdict: PASS — ship it.**

I re-ran the verification commands myself:
- `npx tsc --noEmit` — clean
- `npm test` — 16 files, 172 tests pass
- `npm run build` — clean

### Plan-to-implementation audit

**§1 Types & config** — `WorkflowDifficulty` widened (src/types.ts:3); `WORKFLOW_DIFFICULTIES` constant introduced (src/difficulty.ts:3) and consumed by the `choose_difficulty` enum (src/adapters.ts:495), so the tool schema and the type can't drift. `DEFAULT_WORKFLOW_ROLES['extra-high']` mirrors `high` (src/config.ts:44); `normalizeWorkflowRoles` fills `extra-high` from the normalized `high` block when missing (src/config.ts:222–226). Old-config fallback and default-includes-extra-high are both covered by tests/config.test.ts:32 and :91.

**§2 Parser/prompt/tool surfaces** — All prompt sites called out in the plan were updated: `parseWorkflowReply` regex (src/workflow.ts:1237), `requiredDifficulty` (src/bridgeAgent.ts:956), orchestrator + classifier prompts (src/adapters.ts:975, :1017–1018), `renderDifficultyPrompt`, `planTask` message, plan-preview text, and allowedActions description.

**§3 `plan-rounds-log` artifact** — Added to `ArtifactName` union (src/types.ts), both whitelist arrays (src/bridgeAgent.ts:975, src/adapters.ts:216), and the file-name map (src/artifacts.ts:12).

**§4 Loop** — `runExtraHighPlanningLoop` (src/workflow.ts:706) matches the spec:
- Returns a discriminated union with an explicit paused variant, so the caller (workflow.ts:137) cleanly forwards `needsUserDecision` pauses.
- `reviewerRunCount` increments on each reviewer call; `revisionRound` is not advanced inside the loop — `low/medium/high` semantics preserved.
- Round-3-with-issues path appends `## Outstanding Reviewer Concerns`, adds the decision-log line, prepends the `> Note:` warning, then writes `revised-plan`.
- `writePlanMetadata` runs once at the top of the caller block using `loop.finalPlan` (a real `PlanResult`), so `verificationCommands` / `planPackDraft` survive.

**§4 Approval heuristic** — `isReviewerApproval` (src/workflow.ts:1199) implements the strip-negations-first algorithm. The blocker regex uses `blockers?` and `blocking issues?` (slightly more permissive than the plan's `\bblocker\b|\bblocking issue\b`, but consistent — and the negation-strip runs first, so `no blocking issues` still classifies as approval). Confirmed by the included edge-case test (workflow.test.ts:809–822) including `Approved with blockers → false` and the Chinese case.

**§5–7 Tests & docs** — Three loop scenarios (round-1 approve, round-2 approve, 3-round cap) in tests/workflow.test.ts:663–800; parser canonicalization at :603–620; orchestrator end-to-end dispatch at orchestrator.test.ts:203; choose_difficulty enum assertion at adapters.test.ts:402. Docs in `docs/assistant-workflow.md`, `START_HERE.md`, `START_HERE_FOR_BEGINNERS.md` all mention the new tier.

### Non-blocking nits (do not block ship)

1. The blocker regex `\b(must[-\s]?fix|blockers?|blocking issues?)\b` differs slightly from the plan's wording but is functionally equivalent given the preceding `replace(/no\s+blockers?/, ' ')`. Worth a one-line comment so a future reader doesn't think the negation-strip is dead code, but not required.
2. `EXTRA_HIGH_CAP_NOTE` is written into the in-memory `finalPlan.markdown` before `writePlanMetadata` appends the metadata HTML comment — readers will see Note → plan → metadata, which is the intended order. No issue, just calling it out.
3. The plan called for the metadata-section difficulty list in `src/workflow.ts:~669` to be updated; that spot (now `writeAgentPromptPreview` near :881) iterates `WORKFLOW_DIFFICULTIES`, so it picks up `extra-high` automatically — better than a hardcoded list.

Acceptance criteria from the parent task are all met: user can pick `extra high`, loop runs up to 3 rounds, early-exit on approval, cap-stop with persisted concerns, low/medium/high untouched, build + tests pass.
