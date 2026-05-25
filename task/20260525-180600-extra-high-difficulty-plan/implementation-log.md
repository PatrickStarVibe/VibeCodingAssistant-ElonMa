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
