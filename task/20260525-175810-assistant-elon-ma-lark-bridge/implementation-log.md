## Execution Unit 01: Audit current contract surface (no code change)

Implementation log: tool exists; defect is contract enforcement, not tool surface.

Audit complete, no code changes made. Verified `answer_user_direction` is already defined and exposed through the current contract surface: tool schema in [src/adapters.ts](/C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:521), waiting-state allowlist in [src/adapters.ts](/C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:318), status mapping in [src/adapters.ts](/C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:650), execution branch in [src/bridgeAgent.ts](/C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:327), and final state assertion in [src/bridgeAgent.ts](/C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:464).

Also verified stale `approve_plan`, `accept_task`, and `revise_plan` calls are redirected to `answerUserDirection` while in `waiting_user_direction` at [src/bridgeAgent.ts](/C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:285), [src/bridgeAgent.ts](/C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:305), and [src/bridgeAgent.ts](/C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:345). Existing happy-path coverage is present in [tests/bridgeAgent.test.ts](/C:/Users/24600/OneDrive/文档/Manager/tests/bridgeAgent.test.ts:282).

Test result: `npm --prefix C:\Users\24600\OneDrive\文档\Manager test -- tests/bridgeAgent.test.ts` passed: 1 file, 18 tests. Vitest emitted a Node `DEP0190` warning, but the test run succeeded.

Changed files: none. The worktree already had unrelated dirty `task/...` files before this audit; I left them untouched.

## Execution Unit 02: Strengthen `FAKE_STATE_CLAIM_PATTERN`

Implemented Task 02 in [src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:63).

Changed:
- Extended `FAKE_STATE_CLAIM_PATTERN` for `我会/我来/帮你` action claims, `提交/反馈/转交给 workflow/工作流`, and timed workflow claims like `马上反馈给 workflow`.
- Mirrored those new phrases in `inferFakeClaimIntent`, returning `记录用户选择并反馈给 workflow`.

Test results:
- Passed: `npm --prefix "C:\Users\24600\OneDrive\文档\Manager" test -- tests/bridgeAgent.test.ts` → 18 tests passed.
- Passed: source-level regex smoke check for the new phrase classes.
- Failed: `npx --prefix ... tsc --noEmit -p ...` due an existing `exactOptionalPropertyTypes` issue at `src/bridgeAgent.ts:412` in unchanged `replyGuarded` code; left untouched because it is outside this execution unit.

Changed files:
- `src/bridgeAgent.ts`

## Execution Unit 03: State-aware enforcement for `waiting_user_direction` (Reviewer Finding 1, Blocking)

Implemented Task 03 in [src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:89).

What changed:
- Added `looksLikeUserDirectionAnswer(...)` for numeric, A-D, and short pending-prompt answers.
- Made `replyGuarded` state-aware for `waiting_user_direction`.
- Auto-routes plain replies / `reply_to_user` misuse to `answerUserDirection(...)` when the latest user message looks like an answer, with audit action `guard:direction-autoanswer`.
- Blocks non-answer plain text in `waiting_user_direction` with audit action `guard:direction-text-blocked`.
- Extended `NoOpState` to include `pendingUserPrompt`.

Test results:
- `npm --prefix "C:\Users\24600\OneDrive\文档\Manager" test -- tests/bridgeAgent.test.ts` passed: 18 tests.
- `npx tsc --noEmit` passed.

Changed files from this unit:
- [src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts)

The repo still has pre-existing modified task docs/untracked subtasks; I did not touch or revert those.

## Execution Unit 04: Make `replyNoOp` state-aware and directive

Implemented Task 04 in [src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:453).

`replyNoOp` now prepends a directive when the task is in `waiting_user_direction` and has `pendingUserPrompt`, including the pending question truncated to 200 chars and telling the user that `answer_user_direction` is required. Other states keep the existing no-op message shape.

Test results:
- `npx vitest run tests/bridgeAgent.test.ts --no-color` passed: 18 tests
- `npx tsc --noEmit --pretty false` passed

Changed files:
- [src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts)

## Execution Unit 05: Sharpen the `decideBridgeAction` system prompt

Implemented Task 05 only.

Changed [src/adapters.ts](<C:\Users\24600\OneDrive\文档\Manager\src\adapters.ts:939>) to replace the `waiting_user_direction` prompt rule with the approved two-sentence contract requiring `answer_user_direction` for answers to the pending question, while allowing plain text only for real clarification questions.

Test Result:
`npx vitest run tests/adapters.test.ts --color=false`
Passed: 1 test file, 21 tests.

Changed files:
`src/adapters.ts`

Note: the worktree already has other modified/untracked task files and `src/bridgeAgent.ts`; I did not touch them.

## Execution Unit 06: Regression tests (Reviewer Findings 2 and 4)

Implemented Task 06 regression coverage.

Added waiting-user-direction bridge tests for fake workflow claims, pending prompt no-op text, neutral reply auto-routing, `reply_to_user` misuse auto-routing, and legitimate clarifying question pass-through. Added the adapter prompt smoke test for ``MUST be sent via `answer_user_direction` ``.

While adding the clarifying-question regression, the current guard failed it, so I made a narrow fix in [src/bridgeAgent.ts](</C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:97>) to allow question-shaped clarification replies while keeping bland acknowledgements blocked.

Test results:
- `npx vitest run tests/bridgeAgent.test.ts tests/adapters.test.ts --color=false`: 2 files passed, 45 tests passed
- `npx tsc --noEmit`: passed
- `npm test -- --color=false`: 16 files passed, 147 tests passed

Changed files:
- [src/bridgeAgent.ts](</C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:97>)
- [tests/bridgeAgent.test.ts](</C:/Users/24600/OneDrive/文档/Manager/tests/bridgeAgent.test.ts:182>)
- [tests/adapters.test.ts](</C:/Users/24600/OneDrive/文档/Manager/tests/adapters.test.ts:427>)
