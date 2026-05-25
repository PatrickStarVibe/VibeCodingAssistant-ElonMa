## Execution Unit 01: Type, config, parser, and prompt foundation

Implemented Unit 01 only.

Added `extra-high` as a workflow difficulty, including canonical normalization for `extra high`, `extra-high`, `Extra-High`, and `EXTRA_HIGH`. Updated config defaults, old-config fallback from `high`, bridge/tool parsing, conversation parsing, prompt text, artifact whitelists, and the new `plan-rounds-log` artifact foundation.

Changed files:
- Source/config: `assistant.config.example.json`, `src/difficulty.ts`, `src/types.ts`, `src/config.ts`, `src/workflow.ts`, `src/conversation.ts`, `src/adapters.ts`, `src/bridgeAgent.ts`, `src/allowedActions.ts`, `src/artifacts.ts`, `src/cli.ts`
- Tests/fixtures: `tests/config.test.ts`, `tests/workflow.test.ts`, `tests/bridgeAgent.test.ts`, plus workflow role fixture updates across adapter/conversation/lark/orchestrator/project tests.

Verification:
- `npx tsc --noEmit` passed
- Focused tests passed: 4 files, 75 tests
- `npm test` passed: 16 files, 153 tests
- `npm run build` passed

Note: `src/adapters.ts` and `src/bridgeAgent.ts` were already dirty before this unit; I layered the Unit 01 changes on top. Existing unrelated dirty `task/...` files were left untouched.

## Execution Unit 02: Multi-round Planner ↔ Reviewer loop in `WorkflowService.planTask`

Implemented Unit 02 in [src/workflow.ts](C:/Users/24600/OneDrive/文档/Manager/src/workflow.ts:38).

What changed:
- Added the `extra-high` branch in `planTask`.
- Added the 3-round Planner ↔ Reviewer loop with early approval exit.
- Added `plan-rounds-log` round entries, cap warning note, and decision-log cap entry.
- Added the reviewer approval heuristic and exported it for later tests.
- Preserved existing low / medium / high behavior paths.

Test Result:
- `npx tsc --noEmit` passed
- `npx vitest run tests/workflow.test.ts` passed: 21 tests
- `npm test` passed: 16 files, 153 tests
- `npm run build` passed

Changed files:
- `src/workflow.ts`

## Execution Unit 03: Tests, prompt-routing tests, and documentation

Implemented Task 03 only: tests and docs.

Added coverage for:
- `extra-high` 1-round approval, 2-round approval, and 3-round cap behavior.
- `isReviewerApproval` edge cases.
- `extra high` parser/canonicalization variants.
- Adapter difficulty normalization and `choose_difficulty` enum exposure.
- Orchestrator forwarding an `extra-high` difficulty choice end to end.

Updated docs in:
- [docs/assistant-workflow.md](C:/Users/24600/OneDrive/文档/Manager/docs/assistant-workflow.md)
- [START_HERE.md](C:/Users/24600/OneDrive/文档/Manager/START_HERE.md)
- [START_HERE_FOR_BEGINNERS.md](C:/Users/24600/OneDrive/文档/Manager/START_HERE_FOR_BEGINNERS.md)

Test results:
- `npm test -- --run tests/workflow.test.ts tests/adapters.test.ts tests/orchestrator.test.ts`: 3 files, 68 tests passed.
- `npx tsc --noEmit`: passed.
- `npm test`: 16 files, 172 tests passed.
- `npm run build`: passed.

Changed files for this unit:
- [tests/workflow.test.ts](C:/Users/24600/OneDrive/文档/Manager/tests/workflow.test.ts)
- [tests/adapters.test.ts](C:/Users/24600/OneDrive/文档/Manager/tests/adapters.test.ts)
- [tests/orchestrator.test.ts](C:/Users/24600/OneDrive/文档/Manager/tests/orchestrator.test.ts)
- [docs/assistant-workflow.md](C:/Users/24600/OneDrive/文档/Manager/docs/assistant-workflow.md)
- [START_HERE.md](C:/Users/24600/OneDrive/文档/Manager/START_HERE.md)
- [START_HERE_FOR_BEGINNERS.md](C:/Users/24600/OneDrive/文档/Manager/START_HERE_FOR_BEGINNERS.md)

Pre-existing modified files such as `src/workflow.ts` and task-record files were already dirty when I started and were left untouched.
