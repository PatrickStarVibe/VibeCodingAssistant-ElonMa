## Final Review — Tighten Assistant action-execution contract for Lark bridge

**Verdict: Approved.** No blocking issues found. All execution units implemented as planned; verification commands pass.

### Verification re-run
- `npm test` → 16 files / **147 tests passed** ✓
- `npx tsc --noEmit` → passed ✓
- `npm run build` (tsc -p tsconfig.json) → passed ✓

### Plan ↔ code coverage

| Unit | Status | Notes |
|------|--------|-------|
| 01 Audit | ✓ | Confirmed `answer_user_direction` is fully wired (`src/adapters.ts:521`, allowlist `:318`, executor `src/bridgeAgent.ts:338`, state assertion `:489`). |
| 02 Regex | ✓ | `FAKE_STATE_CLAIM_PATTERN` extended at `src/bridgeAgent.ts:64` to cover 我会/我来/帮你/给…workflow/timed-claims; `inferFakeClaimIntent` mirrored. |
| 03 State-aware enforcement | ✓ | `looksLikeUserDirectionAnswer` at `src/bridgeAgent.ts:90`; `replyGuarded` at `:425` correctly routes plain-text and `reply_to_user` misuse via `answerUserDirection` with `guard:direction-autoanswer`; non-answer text → `guard:direction-text-blocked`. `NoOpState` extended (`:62`). |
| 04 `replyNoOp` directive | ✓ | Pending-prompt directive prepended (`src/bridgeAgent.ts:466-470`), 200-char truncation respected. |
| 05 Prompt sharpened | ✓ | Two-sentence rule with required substring at `src/adapters.ts:943`. |
| 06 Regression tests | ✓ | Tests A–G all present in `tests/bridgeAgent.test.ts` and prompt smoke in `tests/adapters.test.ts`. Existing happy path preserved. |

### Non-blocking observations

1. **Out-of-plan addition (acknowledged):** `looksLikeClarifyingQuestion` was added in Unit 06 to keep Test F green. It runs only when `!isFakeStateClaim(text)`, so a fake-claim phrased as a question is still caught. The heuristic requires both a trailing `?/？` and a Chinese question word — conservative enough.
2. **Auto-route trust assumption:** When user types `1` (or A–D, or ≤30-char text with a pendingPrompt), the latest user message is forwarded verbatim to `workflow.answerUserDirection`. The workflow itself handles validation; that's the intended split, but worth surfacing — a stray short user message during `waiting_user_direction` will now be auto-converted to a workflow answer rather than a no-op.
3. **Worktree hygiene:** The repo had pre-existing dirty files (`src/workflow.ts`, `src/cli.ts`, `src/conversation.ts`, `src/types.ts`, several task docs, etc.) that the implementer correctly left alone. None of them are in the diff for this task. If this task is meant to ship as a single commit, the committer must stage only `src/bridgeAgent.ts`, `src/adapters.ts`, `tests/bridgeAgent.test.ts`, `tests/adapters.test.ts` and the task docs.
4. **Earlier unit logs reported a TS error at `src/bridgeAgent.ts:412`.** That error was resolved by Unit 03's `NoOpState` extension; current `tsc --noEmit` passes cleanly. Worth noting only because Units 01 and 02's logs show it as "failed" — that was transient to the in-progress state, not a residual defect.

### Architectural alignment with the parent task
The parent task asked for:
- Backend-driven, state-aware tool surface — already in place (`bridgeToolNamesForTaskStatus`); not weakened.
- Prompt minimization for stage rules — Unit 05 keeps the prompt edit to a single rule, no new per-status `if` ladder.
- Final execution-layer guard — Unit 03 adds it where it was missing (`waiting_user_direction`); fake-claim path covers other states.

The implementation matches both the letter and the spirit of the plan. Recommend merging.
