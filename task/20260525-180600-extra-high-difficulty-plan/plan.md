# Plan: Add `extra high` Difficulty With Multi-Round Plan Refinement (Revised)

Category: Assistant / Workflow

## Goal
Introduce a fourth workflow difficulty `extra-high` that re-uses high-tier role configuration but runs the Planner ↔ Reviewer exchange up to 3 rounds. Stop early when the Reviewer signals no blocking issues; otherwise stop at the round-3 cap and persist any remaining reviewer concerns into `plan-rounds-log` and the decision log. Existing `low` / `medium` / `high` behavior must not regress; `npm run build` and `npm test` must pass.

## Design Notes

### 1. Type and configuration shape
- Extend `WorkflowDifficulty` (`src/types.ts:3`) to `'low' | 'medium' | 'high' | 'extra-high'`. Canonical machine token is the kebab-case `extra-high`. User-typed `extra high`, `extra-high`, `Extra High`, `EXTRA_HIGH` all normalize to it.
- `WorkflowRoleProfiles` is a strict `Record<WorkflowDifficulty, …>` (`src/types.ts:195`). Once the union widens, **every literal config in the codebase must include an `extra-high` entry** or compilation breaks. Sites to update:
  - `src/config.ts:24` `DEFAULT_WORKFLOW_ROLES` — add `extra-high` block mirroring `high` (architect/planReviewer/developer/finalReviewer same tokens).
  - `assistant.config.example.json` — same.
  - `tests/workflow.test.ts:187` and any other inline configs in that file.
  - `tests/adapters.test.ts:44`.
  - `tests/bridgeAgent.test.ts:109`.
  - `tests/config.test.ts` expectations and any fixture in `tests/orchestrator.test.ts:119–121`.
  - Any other test that constructs an `AssistantConfig` (sweep `workflowRoles:` literally before implementing).
- `normalizeWorkflowRoles` in `src/config.ts`: when an upgraded config is missing the `extra-high` key, **fill it from `high`** rather than throwing. Add a `tests/config.test.ts` case covering default-includes-extra-high and old-config-fallback.

### 2. Parser, prompt, and tool-enum changes (all surfaces, not only the regex)
- `parseWorkflowReply` (`src/workflow.ts:996`): match `low|medium|high|extra[-_ ]?high` (case-insensitive), normalize to `extra-high`. Existing `: instruction` tail unchanged.
- `requiredDifficulty` in `src/bridgeAgent.ts:919`: accept `extra-high`, reject everything else (`extra` alone fails).
- `bridgeTools` `choose_difficulty` enum (`src/adapters.ts:491`): add `extra-high`.
- `intentResultFromContent` and `orchestratorDecisionFromContent` (`src/adapters.ts:357`, `src/adapters.ts:~410`): widen difficulty filter to allow `extra-high`.
- **Hardcoded LLM instruction strings** (these were missed in the first pass and are blocking):
  - `src/adapters.ts:~971` orchestrator routing prompt — list `low/medium/high/extra-high` and one-line description of `extra-high`.
  - `src/adapters.ts:~1013` classifier prompt — same.
  - `src/workflow.ts:~97` `planTask` direct message — same.
  - `src/workflow.ts:~669` plan-preview / metadata prompt difficulty list — same.
- `renderDifficultyPrompt` (`src/workflow.ts:1050`): four bullets; `extra high` description = "high 流程 + Planner ↔ Reviewer 最多 3 轮 plan 打磨". Final line: "Reply with exactly one of: low, medium, high, extra high."
- `src/allowedActions.ts:16` description: "选择 low、medium、high 或 extra high 难度".
- `buildInitialPlanPrompt` (`src/adapters.ts:1326`) just passes the new label through.

### 3. New artifact: `plan-rounds-log`
- Add `plan-rounds-log` to the `ArtifactName` union (`src/types.ts:313`) and to both whitelist arrays (`src/bridgeAgent.ts:933` and `src/adapters.ts:210`).

### 4. Multi-round Planner ↔ Reviewer loop in `WorkflowService.planTask`

For `difficulty === 'extra-high'`, route into a new private helper with an explicit return contract so the existing post-plan code path stays untouched.

**Helper signature and return contract**

```ts
type ExtraHighLoopResult = {
  finalPlan: PlanResult;            // last round's PlanResult — feeds writePlanMetadata
  finalReview: string;              // last round's reviewer markdown
  finalRevisionInstructions: string;// last round's revision-instructions markdown
                                    // ("n/a — approved" if loop ended on approval)
  rounds: number;                   // 1..3, for telemetry/logging
  capHitWithIssues: boolean;        // true iff round 3 ended with blockers
};

private async runExtraHighPlanningLoop(
  state: TaskState,
  task: string,
  projectContext: string,
  scopedConfig: ScopedConfig,
): Promise<ExtraHighLoopResult>
```

The caller in `planTask` does:

1. If `difficulty !== 'extra-high'`: existing `low` / `medium` / `high` code runs **literally unchanged**.
2. Else: `const loop = await this.runExtraHighPlanningLoop(...)`, then **the same downstream block** (`writePlanMetadata(loop.finalPlan, …)`, `explainRevisedPlan(...)`, `ready_for_decision`) runs once with `loop.finalPlan` / `loop.finalReview` / `loop.finalRevisionInstructions`. No double-writes of `revised-plan`, no lost `verificationCommands` / `planPackDraft`.

**Loop body**

Constants: `MAX_EXTRA_HIGH_PLANNING_ROUNDS = 3`. A round = (Planner produces or revises plan) → (Reviewer reviews) → (if not approved) Planner consumes feedback.

Round 1:
- Planner: `heavyAgents.createInitialPlan({ ..., difficulty: 'extra-high' })`. Persist plan markdown into `initial-plan` artifact. Hold the full `PlanResult` in memory.
- Reviewer: `heavyAgents.reviewPlan({ initialPlan: round1Plan.markdown, difficulty: 'extra-high' })`. Increment `reviewerRunCount`. Persist reviewer markdown into `review` artifact.
- Approval check (`isReviewerApproval`): if true → set `finalRevisionInstructions = 'n/a — approved'`, **append round 1 entry to `plan-rounds-log`** (planner output, reviewer output, verdict = `approved`, revision-instructions = n/a), set `revised-plan` = round-1 plan markdown, return.
- Otherwise: call `assistant.createRevisionInstructions(...)`. If `needsUserDecision` is true, pause exactly like the current high path (this preserves the user-direction escape valve). Persist into `revision-instructions`. **Now** append round 1 entry to `plan-rounds-log` with the actual revision instructions just produced.

Rounds 2 and 3:
- Planner: `heavyAgents.revisePlan({ initialPlan: previousRoundPlan.markdown, review: previousRoundReview, revisionInstructions: previousRoundRevisionInstructions, difficulty: 'extra-high' })`. Overwrite `initial-plan` with the new plan markdown so the next reviewer call sees the latest plan via the existing reader path.
- Reviewer: `heavyAgents.reviewPlan(...)`. Increment `reviewerRunCount`. Overwrite `review`.
- Approval check. If approved → set `finalRevisionInstructions = 'n/a — approved'`, append this round's entry with verdict = `approved` (no revision instructions), set `revised-plan` = round-N plan markdown, return.
- If not approved and round < 3: produce revision instructions (with the same `needsUserDecision` pause), then append this round's entry with the new instructions.
- If round 3 not approved: skip the revision-instructions step (no next round to feed); set `finalRevisionInstructions = 'n/a — round 3 cap with issues remaining'`. Append the round-3 entry with verdict = `issues_remain`. Append a `## Outstanding Reviewer Concerns` section to `plan-rounds-log` containing the verbatim final reviewer markdown. Append one line to the existing `decision-log` artifact: `extra-high planning hit 3-round cap; outstanding reviewer concerns recorded in plan-rounds-log.md`. Prepend a `> Note: Reviewer still flagged issues at round 3 — see plan-rounds-log.md.` line to round-3 plan markdown before writing it as `revised-plan`. Set `capHitWithIssues = true` and return.

**Per-round log timing rule (from review):** the round entry is appended **after revision instructions are generated** (or after the approval verdict for the terminating round). This guarantees the log captures the exact instructions that drove the next Planner call. Tests assert this ordering.

**`isReviewerApproval(markdown)` (corrected)**

The previous heuristic was broken because `no blocking issues` contains the substring `blocking issue`. Fix:

```ts
function isReviewerApproval(markdown: string): boolean {
  const text = markdown.toLowerCase().replace(/\s+/g, ' ').trim();

  // Strip negated phrases first so they cannot trigger the blocker check.
  const stripped = text
    .replace(/no\s+blocking\s+issues?/g, ' ')
    .replace(/no\s+blockers?/g, ' ')
    .replace(/no\s+must[-\s]?fix/g, ' ');

  // Hard-blocker tokens — any survivor here means "not approved".
  const blockerRe = /\b(must[-\s]?fix|blocker|blocking issue)\b/;
  if (blockerRe.test(stripped)) return false;

  // Approval phrases.
  const approvalRe = /(no blocking issues?|no issues?|approved|looks good|lgtm|no further (comments|changes)|通过|没有?问题|没有?阻塞|无阻塞|批准)/;
  return approvalRe.test(text);
}
```

Conservative by design: false negatives just spend another round inside the cap; false positives end the loop early, which matters more.

**State bookkeeping**
- `reviewerRunCount` increments once per Reviewer call inside the loop (up to 3 for extra-high).
- `revisionRound` is **not** advanced inside the loop — it remains tied to Manager-side `revise C` / restart attempts so `maxRevisionRounds` semantics for low/medium/high are unchanged.

### 5. Final review and downstream
No structural change. `finalReview` agent reads `revised-plan` as today. The `> Note:` line in `revised-plan` plus `plan-rounds-log` give it the trail when the cap was hit. The `decision-log` line is visible to anyone reading the task folder.

### 6. Tests

Loop scenarios in `tests/workflow.test.ts` (extend `FakeHeavyAgents` to support per-call sequences of plan/review markdown and to track `createInitialPlan` / `revisePlan` / `reviewPlan` call counts):
1. extra-high, reviewer approves on round 1 → 1 reviewer call, 0 revisePlan calls, `plan-rounds-log` has one entry with verdict `approved` and `revision-instructions: n/a`. `revised-plan` = round-1 plan. Status reaches `ready_for_decision`. `verificationCommands` from the round-1 `PlanResult` survive into metadata.
2. extra-high, reviewer approves on round 2 → 2 reviewer calls, 1 revisePlan call. Log has two entries; round 1 entry includes the actual revision instructions used to drive round 2 (assert the substring).
3. extra-high, reviewer keeps issuing blockers → 3 reviewer calls, 2 revisePlan calls, log has three entries plus `## Outstanding Reviewer Concerns`. `decision-log` mentions the cap. `revised-plan` starts with the `> Note:` warning line. Status reaches `ready_for_decision` (no deadlock).

Approval-heuristic unit tests (new `tests/workflow.test.ts` block or co-located helper test):
- `No blocking issues.` → `true`.
- `LGTM` → `true`.
- `Approved.` → `true`.
- `Looks good, but must fix X` → `false`.
- `Approved with blockers` → `false`.
- `没有阻塞问题` → `true`.
- Empty / whitespace → `false`.

Config tests (`tests/config.test.ts`):
- Default `DEFAULT_WORKFLOW_ROLES` contains an `extra-high` entry whose role names equal the `high` entry.
- `normalizeWorkflowRoles` applied to a config missing `extra-high` returns one with `extra-high` filled from `high` (no throw).

Parser test (`tests/adapters.test.ts`):
- `extra high`, `extra-high`, `Extra High`, `EXTRA_HIGH`, `extra high: do X` all parse to canonical `extra-high` (with instruction tail preserved where present).

Bridge / orchestrator routing tests:
- `tests/bridgeAgent.test.ts`: `requiredDifficulty` accepts `extra-high`, rejects `extra`.
- `tests/orchestrator.test.ts`: dispatch test that the orchestrator path forwards an `extra-high` choice all the way through to the workflow (not only private parser logic). Add `extra-high` to the test config's `workflowRoles`.

Existing assertion update:
- `tests/workflow.test.ts:281–287` (the `pauses at awaiting_difficulty_selection` test) updated to expect all four tiers in the prompt text.
- `planThroughDifficulty` helper extended to support `'extra-high'`.

### 7. Docs
- `docs/assistant-workflow.md`: new "Extra high difficulty" section explaining the loop, the 3-round cap, the `plan-rounds-log` artifact, and where outstanding reviewer concerns end up (including the `> Note:` line on `revised-plan` and the `decision-log` entry).
- `START_HERE.md` and `START_HERE_FOR_BEGINNERS.md`: one-line additions to the difficulty list.

### 8. Risks / non-goals
- Approval detection stays string-based — no extra LLM call. Worst case is one wasted round inside a 3-round cap.
- Loop is strictly sequential. No parallel Planner/Reviewer.
- No new CLI commands; difficulty selection still flows through `awaiting_difficulty_selection`.
- `low` / `medium` / `high` code paths are untouched beyond the difficulty-type widening, parser, prompt strings, and tool enum.

## Execution Unit 01: Type, config, parser, and prompt foundation

- Widen `WorkflowDifficulty` to include `'extra-high'` (`src/types.ts:3`).
- Add `extra-high` block to `DEFAULT_WORKFLOW_ROLES` (`src/config.ts:24`) mirroring `high`. Update `assistant.config.example.json`.
- Soften `normalizeWorkflowRoles` to fill missing `extra-high` from `high`.
- Add `extra-high` literal to **every** `AssistantConfig.workflowRoles` site in tests: `tests/workflow.test.ts:187`, `tests/adapters.test.ts:44`, `tests/bridgeAgent.test.ts:109`, `tests/orchestrator.test.ts:119–121`, `tests/config.test.ts`, and any other config fixture (sweep before implementing — strict `Record` will otherwise break the build).
- Update `parseWorkflowReply` regex (`src/workflow.ts:996`) to canonicalize the `extra high` family to `extra-high`.
- Update `requiredDifficulty` (`src/bridgeAgent.ts:919`).
- Update `intentResultFromContent` and `orchestratorDecisionFromContent` filters (`src/adapters.ts`).
- Extend `bridgeTools` `choose_difficulty` enum (`src/adapters.ts:491`).
- Update **all** hardcoded LLM prompt strings that list difficulty tiers:
  - `src/adapters.ts:~971` (orchestrator routing).
  - `src/adapters.ts:~1013` (classifier).
  - `src/workflow.ts:~97` (`planTask` direct message).
  - `src/workflow.ts:~669` (plan-preview difficulty list).
  - `renderDifficultyPrompt` (`src/workflow.ts:1050`).
  - `src/allowedActions.ts:16`.
- Add `plan-rounds-log` to the `ArtifactName` union (`src/types.ts:313`) and to both whitelist arrays (`src/bridgeAgent.ts:933`, `src/adapters.ts:210`).

Acceptance for Unit 01: `npx tsc --noEmit` clean across `src/` and `tests/`; existing tests still pass; parser canonicalizes `extra high` / `Extra-High` / `EXTRA_HIGH` to `extra-high`; `requiredDifficulty` accepts `extra-high` and rejects `extra`; `tests/config.test.ts` covers default-contains-extra-high and old-config-fallback.

## Execution Unit 02: Multi-round Planner ↔ Reviewer loop in `WorkflowService.planTask`

- Add `MAX_EXTRA_HIGH_PLANNING_ROUNDS = 3` constant.
- Add `isReviewerApproval(markdown)` helper using the strip-negations-first algorithm above.
- Add `runExtraHighPlanningLoop` with the explicit return type `ExtraHighLoopResult` defined in §4.
- Branch in `planTask`:

  ```ts
  if (difficulty === 'extra-high') {
    const loop = await this.runExtraHighPlanningLoop(state, task, projectContext, scopedConfig);
    finalPlan = loop.finalPlan;
    finalReview = loop.finalReview;
    finalRevisionInstructions = loop.finalRevisionInstructions;
  } else {
    // existing low / medium / high block — unchanged
  }
  // existing writePlanMetadata + explainRevisedPlan + ready_for_decision block — unchanged
  ```

- Loop body per §4: per-round artifacts (`initial-plan`, `review`, `revision-instructions`) hold the latest round; `plan-rounds-log` accumulates per-round transcripts **after revision instructions are generated** for the round (or after verdict for the terminating round).
- Round-3-with-issues path: append `## Outstanding Reviewer Concerns` to `plan-rounds-log`, append one line to `decision-log`, prepend `> Note: …` to round-3 plan markdown before writing it as `revised-plan`.
- Honor existing `assistant.createRevisionInstructions` `needsUserDecision` pause and `assistant.explainRevisedPlan` `needsUserDecision` pause exactly as in the high path.
- Confirm `low`, `medium`, `high` branches are byte-identical to today.

Acceptance for Unit 02: loop runs 1–3 rounds; early exit on approval (no `revisePlan` call, no revision instructions written for that round); cap path persists outstanding concerns and warning note; `writePlanMetadata` consumes a real `PlanResult` (so `verificationCommands` / `planPackDraft` survive); `low` / `medium` / `high` test scenarios unchanged.

## Execution Unit 03: Tests, prompt-routing tests, and documentation

- Extend `FakeHeavyAgents` to support per-call sequences and call-count tracking for `createInitialPlan`, `revisePlan`, `reviewPlan`.
- Add the three loop-scenario tests (approve round 1, approve round 2, never approves) per §6.
- Add the approval-heuristic unit test block per §6 (including `No blocking issues.` → true, `Looks good, but must fix X` → false, `Approved with blockers` → false, Chinese variants).
- Add config normalization tests in `tests/config.test.ts`: default contains `extra-high`; old config without `extra-high` is filled from `high`.
- Add parser test in `tests/adapters.test.ts` for the `extra high` family.
- Add `requiredDifficulty` test in `tests/bridgeAgent.test.ts`.
- Add orchestrator routing test in `tests/orchestrator.test.ts` that dispatches an `extra-high` choice end-to-end through the bridge/orchestrator path (not only the private parser).
- Update the difficulty-prompt assertion (`tests/workflow.test.ts:281–287`) to expect four tiers.
- Update `planThroughDifficulty` helper to support `'extra-high'`.
- Docs: add "Extra high difficulty" section to `docs/assistant-workflow.md`. Add the new tier to the lists in `START_HERE.md` and `START_HERE_FOR_BEGINNERS.md`.

Acceptance for Unit 03: `npm test` and `npm run build` pass; new loop and approval tests fail without Unit 02 changes; new config and prompt-routing tests fail without Unit 01 changes.

## Verification Commands

- npx tsc --noEmit
- npm test
- npm run build
