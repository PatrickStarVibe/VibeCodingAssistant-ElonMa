# Task Record: 新增 extra high difficulty 档位及多轮 Plan 打磨机制

## Summary

Category: Assistant / Workflow

## User Acceptance

Accepted at 2026-05-25T18:56:24.527Z.
User notes: None.

## Implementation Process

Plan, sequential execution, final review, and user acceptance were completed through Assistant Elon Ma.

## Files Changed

M START_HERE.md
M START_HERE_FOR_BEGINNERS.md
M docs/assistant-workflow.md
M src/workflow.ts
M task/20260525-180600-extra-high-difficulty-plan/implementation-log.md
M task/20260525-180600-extra-high-difficulty-plan/subtasks/02-multi-round-planner-reviewer-loop-in-wor.md
M task/20260525-180600-extra-high-difficulty-plan/subtasks/03-tests-prompt-routing-tests-and-documenta.md
M tests/adapters.test.ts
M tests/orchestrator.test.ts
M tests/workflow.test.ts

## Behavior Changed

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

## Algorithm Logic

No specific product algorithm was recorded by Assistant Elon Ma for this task unless noted in the implementation log.

## Connected Systems

See implementation log and final review for connected systems.

## Reserved Interfaces / Future Hooks

No reserved interfaces or future hooks were recorded unless noted in the implementation log.

## Tests Run

# Execution Unit 01: Type, config, parser, and prompt foundation

## npx tsc --noEmit

Status: passed

```

```

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 55ms
 ✓ tests/intentRouting.test.ts (5 tests) 129ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 29ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 17ms
 ✓ tests/larkTransport.test.ts (20 tests) 510ms
 ✓ tests/adapters.test.ts (22 tests) 32ms
 ✓ tests/conversation.test.ts (14 tests) 555ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 22ms
 ✓ tests/projectRegistry.test.ts (4 tests) 34ms
 ✓ tests/config.test.ts (7 tests) 22ms
 ✓ tests/textSanitizer.test.ts (3 tests) 12ms
 ✓ tests/verification.test.ts (3 tests) 2ms
 ✓ tests/larkCli.test.ts (1 test) 8ms
 ✓ tests/bridgeAgent.test.ts (25 tests) 1572ms
     ✓ accepts completed work via accept_task tool calls  502ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  352ms
     ✓ catches async tool failures and explains instead of throwing out to transport  332ms
 ✓ tests/orchestrator.test.ts (6 tests) 1853ms
     ✓ dispatches a difficulty choice from the first workflow gate  327ms
     ✓ approves implementation only from a ready plan with high confidence  700ms
 ✓ tests/workflow.test.ts (21 tests) 4213ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  584ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  455ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  436ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  404ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  410ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  398ms

 Test Files  16 passed (16)
      Tests  153 passed (153)
   Start at  14:35:02
   Duration  4.61s (transform 775ms, setup 0ms, import 1.36s, tests 9.07s, environment 1ms)


(node:439720) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:447324) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:447988) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-183503-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-183503-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-183503-agent-task.
```

## npm run build

Status: passed

```
> assistant-ai-workflow@0.1.0 build
> tsc -p tsconfig.json
```
# Execution Unit 02: Multi-round Planner ↔ Reviewer loop in `WorkflowService.planTask`

## npx tsc --noEmit

Status: passed

```

```

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 60ms
 ✓ tests/intentRouting.test.ts (5 tests) 172ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 30ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 21ms
 ✓ tests/conversation.test.ts (14 tests) 536ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 23ms
 ✓ tests/adapters.test.ts (22 tests) 39ms
 ✓ tests/larkTransport.test.ts (20 tests) 715ms
 ✓ tests/projectRegistry.test.ts (4 tests) 19ms
 ✓ tests/config.test.ts (7 tests) 23ms
 ✓ tests/textSanitizer.test.ts (3 tests) 12ms
 ✓ tests/verification.test.ts (3 tests) 2ms
 ✓ tests/larkCli.test.ts (1 test) 9ms
 ✓ tests/bridgeAgent.test.ts (25 tests) 1853ms
     ✓ accepts completed work via accept_task tool calls  607ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  398ms
     ✓ catches async tool failures and explains instead of throwing out to transport  338ms
 ✓ tests/orchestrator.test.ts (6 tests) 2206ms
     ✓ dispatches a difficulty choice from the first workflow gate  429ms
     ✓ approves implementation only from a ready plan with high confidence  796ms
 ✓ tests/workflow.test.ts (21 tests) 4745ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  725ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  471ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  578ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  462ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  410ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  446ms

 Test Files  16 passed (16)
      Tests  153 passed (153)
   Start at  14:42:25
   Duration  5.11s (transform 675ms, setup 0ms, import 1.30s, tests 10.47s, environment 1ms)


(node:430444) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:461464) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:461468) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-184226-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-184226-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-184227-agent-task.
```

## npm run build

Status: passed

```
> assistant-ai-workflow@0.1.0 build
> tsc -p tsconfig.json
```
# Execution Unit 03: Tests, prompt-routing tests, and documentation

## npx tsc --noEmit

Status: passed

```

```

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 64ms
 ✓ tests/intentRouting.test.ts (5 tests) 204ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 29ms
 ✓ tests/adapters.test.ts (26 tests) 32ms
 ✓ tests/projectRegistry.test.ts (4 tests) 20ms
 ✓ tests/conversation.test.ts (14 tests) 655ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 20ms
 ✓ tests/config.test.ts (7 tests) 31ms
 ✓ tests/textSanitizer.test.ts (3 tests) 9ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 18ms
 ✓ tests/larkTransport.test.ts (20 tests) 962ms
 ✓ tests/verification.test.ts (3 tests) 2ms
 ✓ tests/larkCli.test.ts (1 test) 9ms
 ✓ tests/bridgeAgent.test.ts (25 tests) 1686ms
     ✓ accepts completed work via accept_task tool calls  477ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  404ms
     ✓ catches async tool failures and explains instead of throwing out to transport  321ms
 ✓ tests/orchestrator.test.ts (7 tests) 2198ms
     ✓ dispatches a difficulty choice from the first workflow gate  359ms
     ✓ approves implementation only from a ready plan with high confidence  731ms
 ✓ tests/workflow.test.ts (35 tests) 5103ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  666ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  447ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  475ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  408ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  434ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  421ms

 Test Files  16 passed (16)
      Tests  172 passed (172)
   Start at  14:50:31
   Duration  5.56s (transform 964ms, setup 0ms, import 1.58s, tests 11.04s, environment 1ms)


(node:466704) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:466884) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:466720) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-185033-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-185033-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-185033-agent-task.
```

## npm run build

Status: passed

```
> assistant-ai-workflow@0.1.0 build
> tsc -p tsconfig.json
```

## Known Remaining Issues

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

## Future Follow-ups

None recorded.
