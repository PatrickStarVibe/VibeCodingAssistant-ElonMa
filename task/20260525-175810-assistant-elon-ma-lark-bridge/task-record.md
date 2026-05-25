# Task Record: 修复 Assistant Elon Ma / Lark bridge 动作执行契约

## Summary

**Category:** Assistant / Workflow

## User Acceptance

Accepted at 2026-05-25T18:32:58.663Z.
User notes: None.

## Implementation Process

Plan, sequential execution, final review, and user acceptance were completed through Assistant Elon Ma.

## Files Changed

M assistant.config.example.json
M src/adapters.ts
M src/allowedActions.ts
M src/artifacts.ts
M src/bridgeAgent.ts
M src/cli.ts
M src/config.ts
M src/conversation.ts
M src/types.ts
M src/workflow.ts
M task/20260525-175810-assistant-elon-ma-lark-bridge/implementation-log.md
M task/20260525-180600-extra-high-difficulty-plan/README.md
M task/20260525-180600-extra-high-difficulty-plan/plan-review.md
M task/20260525-180600-extra-high-difficulty-plan/plan.md
M tests/adapters.test.ts
M tests/bridgeAgent.test.ts
M tests/larkTransport.test.ts
M tests/orchestrator.test.ts
M tests/projectRegistry.test.ts
M tests/workflow.test.ts
?? src/difficulty.ts
?? task/20260525-180600-extra-high-difficulty-plan/subtasks/

## Behavior Changed

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

## Algorithm Logic

No specific product algorithm was recorded by Assistant Elon Ma for this task unless noted in the implementation log.

## Connected Systems

See implementation log and final review for connected systems.

## Reserved Interfaces / Future Hooks

No reserved interfaces or future hooks were recorded unless noted in the implementation log.

## Tests Run

# Execution Unit 01: Audit current contract surface (no code change)

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/intentRouting.test.ts (5 tests) 130ms
 ✓ tests/larkCli.test.ts (1 test) 11ms
 ✓ tests/taskRecords.test.ts (4 tests) 52ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 30ms
 ✓ tests/larkTransport.test.ts (20 tests) 534ms
 ✓ tests/adapters.test.ts (21 tests) 28ms
 ✓ tests/conversation.test.ts (14 tests) 666ms
 ✓ tests/projectRegistry.test.ts (4 tests) 22ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 17ms
 ✓ tests/config.test.ts (6 tests) 17ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 21ms
 ✓ tests/textSanitizer.test.ts (3 tests) 12ms
 ✓ tests/verification.test.ts (3 tests) 2ms
 ✓ tests/bridgeAgent.test.ts (18 tests) 1592ms
     ✓ accepts completed work via accept_task tool calls  600ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  445ms
     ✓ catches async tool failures and explains instead of throwing out to transport  333ms
 ✓ tests/orchestrator.test.ts (6 tests) 2041ms
     ✓ dispatches a difficulty choice from the first workflow gate  411ms
     ✓ approves implementation only from a ready plan with high confidence  783ms
 ✓ tests/workflow.test.ts (18 tests) 4242ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  762ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  451ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  449ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  415ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  407ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  448ms

 Test Files  16 passed (16)
      Tests  141 passed (141)
   Start at  14:11:15
   Duration  4.67s (transform 843ms, setup 0ms, import 1.54s, tests 9.42s, environment 1ms)


(node:397752) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:429980) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:396148) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-181117-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-181117-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-181117-agent-task.
```

## npx tsc --noEmit

Status: failed

```
src/bridgeAgent.ts(412,27): error TS2379: Argument of type '{ state: (Pick<TaskState, "difficulty" | "status" | "taskId" | "title" | "pendingUserPrompt" | "revisionRound" | "reviewerRunCount" | "requestedChanges"> & { ...; }) | undefined; input: BridgeAgentInput; intendedAction: string; reason: string; auditAction: "guard:fake-claim"; }' is not assignable to parameter of type '{ state?: NoOpState; input?: BridgeAgentInput; intendedAction: string; reason: string; auditAction: "guard:state-mismatch" | "guard:no-tool" | "guard:fake-claim"; }' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
  Types of property 'state' are incompatible.
    Type '(Pick<TaskState, "difficulty" | "status" | "taskId" | "title" | "pendingUserPrompt" | "revisionRound" | "reviewerRunCount" | "requestedChanges"> & { ...; }) | undefined' is not assignable to type 'NoOpState'.
      Type 'undefined' is not assignable to type 'NoOpState'.
```
# Execution Unit 02: Strengthen `FAKE_STATE_CLAIM_PATTERN`

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 56ms
 ✓ tests/intentRouting.test.ts (5 tests) 157ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 29ms
 ✓ tests/conversation.test.ts (14 tests) 388ms
 ✓ tests/adapters.test.ts (21 tests) 32ms
 ✓ tests/projectRegistry.test.ts (4 tests) 25ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 16ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 18ms
 ✓ tests/config.test.ts (6 tests) 16ms
 ✓ tests/textSanitizer.test.ts (3 tests) 12ms
 ✓ tests/verification.test.ts (3 tests) 3ms
 ✓ tests/larkTransport.test.ts (20 tests) 966ms
 ✓ tests/larkCli.test.ts (1 test) 8ms
 ✓ tests/bridgeAgent.test.ts (18 tests) 1626ms
     ✓ accepts completed work via accept_task tool calls  581ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  473ms
     ✓ catches async tool failures and explains instead of throwing out to transport  333ms
 ✓ tests/orchestrator.test.ts (6 tests) 1993ms
     ✓ dispatches a difficulty choice from the first workflow gate  347ms
     ✓ approves implementation only from a ready plan with high confidence  806ms
 ✓ tests/workflow.test.ts (18 tests) 4072ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  681ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  442ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  457ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  432ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  405ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  405ms

 Test Files  16 passed (16)
      Tests  141 passed (141)
   Start at  14:15:13
   Duration  4.45s (transform 672ms, setup 0ms, import 1.28s, tests 9.42s, environment 1ms)


(node:415176) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:430784) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:430956) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-181514-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-181514-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-181515-agent-task.
```

## npx tsc --noEmit

Status: failed

```
src/bridgeAgent.ts(412,27): error TS2379: Argument of type '{ state: (Pick<TaskState, "difficulty" | "status" | "taskId" | "title" | "pendingUserPrompt" | "revisionRound" | "reviewerRunCount" | "requestedChanges"> & { ...; }) | undefined; input: BridgeAgentInput; intendedAction: string; reason: string; auditAction: "guard:fake-claim"; }' is not assignable to parameter of type '{ state?: NoOpState; input?: BridgeAgentInput; intendedAction: string; reason: string; auditAction: "guard:state-mismatch" | "guard:no-tool" | "guard:fake-claim"; }' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
  Types of property 'state' are incompatible.
    Type '(Pick<TaskState, "difficulty" | "status" | "taskId" | "title" | "pendingUserPrompt" | "revisionRound" | "reviewerRunCount" | "requestedChanges"> & { ...; }) | undefined' is not assignable to type 'NoOpState'.
      Type 'undefined' is not assignable to type 'NoOpState'.
```
# Execution Unit 03: State-aware enforcement for `waiting_user_direction` (Reviewer Finding 1, Blocking)

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 53ms
 ✓ tests/intentRouting.test.ts (5 tests) 133ms
 ✓ tests/adapters.test.ts (21 tests) 27ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 29ms
 ✓ tests/conversation.test.ts (14 tests) 445ms
 ✓ tests/projectRegistry.test.ts (4 tests) 32ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 20ms
 ✓ tests/larkTransport.test.ts (20 tests) 623ms
 ✓ tests/config.test.ts (6 tests) 16ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 17ms
 ✓ tests/textSanitizer.test.ts (3 tests) 13ms
 ✓ tests/verification.test.ts (3 tests) 3ms
 ✓ tests/larkCli.test.ts (1 test) 9ms
 ✓ tests/bridgeAgent.test.ts (18 tests) 1536ms
     ✓ accepts completed work via accept_task tool calls  567ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  391ms
     ✓ catches async tool failures and explains instead of throwing out to transport  352ms
 ✓ tests/orchestrator.test.ts (6 tests) 1896ms
     ✓ dispatches a difficulty choice from the first workflow gate  339ms
     ✓ approves implementation only from a ready plan with high confidence  714ms
 ✓ tests/workflow.test.ts (18 tests) 3952ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  620ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  455ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  439ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  414ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  433ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  402ms

 Test Files  16 passed (16)
      Tests  141 passed (141)
   Start at  14:20:25
   Duration  4.34s (transform 673ms, setup 0ms, import 1.19s, tests 8.80s, environment 1ms)


(node:432908) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:400136) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:433376) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182027-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182027-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182027-agent-task.
```

## npx tsc --noEmit

Status: passed

```

```
# Execution Unit 04: Make `replyNoOp` state-aware and directive

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 55ms
 ✓ tests/intentRouting.test.ts (5 tests) 135ms
 ✓ tests/projectRegistry.test.ts (4 tests) 22ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 27ms
 ✓ tests/adapters.test.ts (21 tests) 27ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 20ms
 ✓ tests/conversation.test.ts (14 tests) 671ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 17ms
 ✓ tests/config.test.ts (6 tests) 17ms
 ✓ tests/larkTransport.test.ts (20 tests) 849ms
 ✓ tests/textSanitizer.test.ts (3 tests) 11ms
 ✓ tests/verification.test.ts (3 tests) 3ms
 ✓ tests/larkCli.test.ts (1 test) 10ms
 ✓ tests/bridgeAgent.test.ts (18 tests) 1585ms
     ✓ accepts completed work via accept_task tool calls  572ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  430ms
     ✓ catches async tool failures and explains instead of throwing out to transport  350ms
 ✓ tests/orchestrator.test.ts (6 tests) 2037ms
     ✓ dispatches a difficulty choice from the first workflow gate  428ms
     ✓ approves implementation only from a ready plan with high confidence  706ms
 ✓ tests/workflow.test.ts (18 tests) 4061ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  660ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  485ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  449ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  463ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  413ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  407ms

 Test Files  16 passed (16)
      Tests  141 passed (141)
   Start at  14:22:34
   Duration  4.43s (transform 633ms, setup 0ms, import 1.22s, tests 9.55s, environment 1ms)


(node:437896) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:434320) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:437900) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182235-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182235-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182235-agent-task.
```

## npx tsc --noEmit

Status: passed

```

```
# Execution Unit 05: Sharpen the `decideBridgeAction` system prompt

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 50ms
 ✓ tests/intentRouting.test.ts (5 tests) 125ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 30ms
 ✓ tests/adapters.test.ts (21 tests) 30ms
 ✓ tests/conversation.test.ts (14 tests) 424ms
 ✓ tests/projectRegistry.test.ts (4 tests) 24ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 19ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 15ms
 ✓ tests/config.test.ts (6 tests) 17ms
 ✓ tests/textSanitizer.test.ts (3 tests) 12ms
 ✓ tests/larkTransport.test.ts (20 tests) 802ms
 ✓ tests/verification.test.ts (3 tests) 3ms
 ✓ tests/larkCli.test.ts (1 test) 9ms
 ✓ tests/bridgeAgent.test.ts (18 tests) 1531ms
     ✓ accepts completed work via accept_task tool calls  547ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  403ms
     ✓ catches async tool failures and explains instead of throwing out to transport  355ms
 ✓ tests/orchestrator.test.ts (6 tests) 1909ms
     ✓ dispatches a difficulty choice from the first workflow gate  335ms
     ✓ approves implementation only from a ready plan with high confidence  712ms
 ✓ tests/workflow.test.ts (18 tests) 3997ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  661ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  474ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  422ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  442ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  413ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  392ms

 Test Files  16 passed (16)
      Tests  141 passed (141)
   Start at  14:24:22
   Duration  4.37s (transform 620ms, setup 0ms, import 1.21s, tests 9.00s, environment 1ms)


(node:437552) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:440064) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:436072) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182424-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182424-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182424-agent-task.
```

## npx tsc --noEmit

Status: passed

```

```
# Execution Unit 06: Regression tests (Reviewer Findings 2 and 4)

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 58ms
 ✓ tests/intentRouting.test.ts (5 tests) 150ms
 ✓ tests/adapters.test.ts (22 tests) 30ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 27ms
 ✓ tests/conversation.test.ts (14 tests) 412ms
 ✓ tests/config.test.ts (6 tests) 18ms
 ✓ tests/larkTransport.test.ts (20 tests) 575ms
 ✓ tests/projectRegistry.test.ts (4 tests) 21ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 17ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 23ms
 ✓ tests/textSanitizer.test.ts (3 tests) 11ms
 ✓ tests/verification.test.ts (3 tests) 2ms
 ✓ tests/larkCli.test.ts (1 test) 9ms
 ✓ tests/bridgeAgent.test.ts (23 tests) 1595ms
     ✓ accepts completed work via accept_task tool calls  488ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  389ms
     ✓ catches async tool failures and explains instead of throwing out to transport  364ms
 ✓ tests/orchestrator.test.ts (6 tests) 1909ms
     ✓ dispatches a difficulty choice from the first workflow gate  310ms
     ✓ approves implementation only from a ready plan with high confidence  721ms
 ✓ tests/workflow.test.ts (18 tests) 4061ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  637ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  467ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  450ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  424ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  442ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  419ms

 Test Files  16 passed (16)
      Tests  147 passed (147)
   Start at  14:29:35
   Duration  4.42s (transform 688ms, setup 0ms, import 1.29s, tests 8.92s, environment 1ms)


(node:446164) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:434716) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:446188) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182937-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182937-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-182937-agent-task.
```

## npx tsc --noEmit

Status: passed

```

```

## Known Remaining Issues

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

## Future Follow-ups

None recorded.
