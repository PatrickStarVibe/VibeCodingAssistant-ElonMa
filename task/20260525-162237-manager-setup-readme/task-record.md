# Task Record: 为 Manager 项目新增 setup README

## Summary

**Category:** Docs / Task Record

## User Acceptance

Accepted at 2026-05-25T17:23:04.215Z.
User notes: None.

## Implementation Process

Plan, sequential execution, final review, and user acceptance were completed through Assistant Elon Ma.

## Files Changed

M .env.example
?? README.md

## Behavior Changed

## Execution Unit 01: Main

Implemented the setup guide in [START_HERE.md](<C:/Users/24600/OneDrive/文档/Manager/START_HERE.md>). It now covers required user information, local config copying, `.env.local`, project setup, adding projects, Lark bridge startup, access checks, common errors, and a copyable “Prompt for your coding agent” checklist. I also scanned the file for the disallowed provider names and found no hits.

Test results:
- `Get-Content -Raw -Encoding utf8 START_HERE.md` passed.
- `npm run build` passed.
- `npm test` passed: 16 test files, 135 tests. Vitest emitted existing Node `DEP0190` warnings, but all tests passed.

Changed files:
- `START_HERE.md`

Note: the worktree already had unrelated modified task files; I left them untouched.
## Execution Unit 01: Main

已完成当前执行单元。更新了 `START_HERE.md` 的 setup smoke-test 流程，补上了 `plan` 后选择 `low|medium|high`、查看 artifacts、批准/返修计划、查看 final review、最终 `accept` 生成 task record，以及 final review 路由回实现/规划时该怎么继续。

验证结果：
- `Get-Content -Raw -Encoding utf8 START_HERE.md`：通过
- `npm run build`：通过
- `npm test`：通过，16 files / 135 tests passed；测试输出里有 Node `DEP0190` deprecation warning，但测试成功

Changed files:
- `START_HERE.md`

工作区里还有既有的 `task/...` 变更和未跟踪 `subtasks/`，我没有改动它们。
## Execution Unit 01: Main

Implemented the setup README work.

Changed files:
- Added [README.md](C:/Users/24600/OneDrive/文档/Manager/README.md:1)
- Updated [START_HERE.md](C:/Users/24600/OneDrive/文档/Manager/START_HERE.md:1)
- Updated [.env.example](C:/Users/24600/OneDrive/文档/Manager/.env.example:7)

What changed:
- Added a root README entry point pointing users to `START_HERE.md`.
- Expanded `START_HERE.md` with provider-agnostic setup steps: required info, copying example config to local config, `.env.local`, adding projects, Lark bridge startup, access verification, common errors, and `Prompt for your coding agent`.
- Added explicit post-`Plan difficulty selection` steps, including checking `agent-prompt-preview`, choosing difficulty, approving/revising, and accepting final review.
- Cleaned `.env.example` so the copied local env template does not name specific LLM providers.

Verification:
- `git diff -- README.md START_HERE.md .env.example` passed for review.
- Required setup-term `rg` check passed.
- Provider-name `rg` check over `README.md`, `START_HERE.md`, and `.env.example` returned no matches.
- No code tests were run because this execution unit only changed setup docs/env template.

I left unrelated existing worktree changes untouched, including `src/adapters.ts` and `tests/adapters.test.ts`.

## Algorithm Logic

No specific product algorithm was recorded by Assistant Elon Ma for this task unless noted in the implementation log.

## Connected Systems

See implementation log and final review for connected systems.

## Reserved Interfaces / Future Hooks

No reserved interfaces or future hooks were recorded unless noted in the implementation log.

## Tests Run

# Execution Unit 01: Main

## npm run build

Status: passed

```
> assistant-ai-workflow@0.1.0 build
> tsc -p tsconfig.json
```

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 68ms
 ✓ tests/intentRouting.test.ts (5 tests) 172ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 31ms
 ✓ tests/conversation.test.ts (14 tests) 429ms
 ✓ tests/adapters.test.ts (17 tests) 28ms
 ✓ tests/projectRegistry.test.ts (4 tests) 25ms
 ✓ tests/config.test.ts (6 tests) 19ms
 ✓ tests/larkTransport.test.ts (20 tests) 656ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 28ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 29ms
 ✓ tests/verification.test.ts (3 tests) 3ms
 ✓ tests/textSanitizer.test.ts (3 tests) 13ms
 ✓ tests/larkCli.test.ts (1 test) 10ms
 ✓ tests/bridgeAgent.test.ts (16 tests) 1576ms
     ✓ accepts completed work via accept_task tool calls  578ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  433ms
     ✓ catches async tool failures and explains instead of throwing out to transport  353ms
 ✓ tests/orchestrator.test.ts (6 tests) 1998ms
     ✓ dispatches a difficulty choice from the first workflow gate  396ms
     ✓ approves implementation only from a ready plan with high confidence  723ms
 ✓ tests/workflow.test.ts (18 tests) 4180ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  629ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  504ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  447ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  419ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  442ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  448ms

 Test Files  16 passed (16)
      Tests  135 passed (135)
   Start at  12:29:57
   Duration  4.57s (transform 721ms, setup 0ms, import 1.32s, tests 9.26s, environment 1ms)


(node:360236) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:363492) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:364744) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-162958-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-162958-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-162959-agent-task.
```
# Execution Unit 01: Main

## npm run build

Status: passed

```
> assistant-ai-workflow@0.1.0 build
> tsc -p tsconfig.json
```

## npm test

Status: passed

```
> assistant-ai-workflow@0.1.0 test
> vitest run


 RUN  v4.1.7 C:/Users/24600/OneDrive/文档/Manager

 ✓ tests/taskRecords.test.ts (4 tests) 74ms
 ✓ tests/intentRouting.test.ts (5 tests) 159ms
 ✓ tests/adapters.test.ts (17 tests) 49ms
 ✓ tests/projectRegistry.test.ts (4 tests) 43ms
 ✓ tests/larkTransport.test.ts (20 tests) 574ms
 ✓ tests/conversation.test.ts (14 tests) 639ms
 ✓ tests/config.test.ts (6 tests) 24ms
 ✓ scripts/task-usage/__tests__/summarizeTaskUsage.test.ts (10 tests) 38ms
 ✓ tests/projectKnowledge.test.ts (3 tests) 25ms
 ✓ tests/textSanitizer.test.ts (3 tests) 12ms
 ✓ tests/larkBridgeMemory.test.ts (5 tests) 32ms
 ✓ tests/verification.test.ts (3 tests) 3ms
 ✓ tests/larkCli.test.ts (1 test) 9ms
 ✓ tests/bridgeAgent.test.ts (16 tests) 1696ms
     ✓ accepts completed work via accept_task tool calls  677ms
     ✓ renders awaiting acceptance status without saying the plan still needs approval  430ms
     ✓ catches async tool failures and explains instead of throwing out to transport  327ms
 ✓ tests/orchestrator.test.ts (6 tests) 2057ms
     ✓ dispatches a difficulty choice from the first workflow gate  446ms
     ✓ approves implementation only from a ready plan with high confidence  762ms
 ✓ tests/workflow.test.ts (18 tests) 4192ms
     ✓ binds tasks to projects and injects project Markdown into assistant and heavy-agent prompts  760ms
     ✓ approves, implements, final-reviews, and writes a final report with dirty sections  455ms
     ✓ persists approved plan artifacts, runs decomposed execution units sequentially, and waits for user acceptance  454ms
     ✓ routes after failed final review through { route: 'route_to_implementer', reason: 'Contained bug remains.' }  411ms
     ✓ routes after failed final review through { route: 'route_to_planner', reason: 'The plan missed a design constraint.' }  420ms
     ✓ routes after failed final review through { route: 'ask_user_direction', reason: 'Scope choice needed.', userPrompt: 'Choose MVP or full scope.' }  428ms

 Test Files  16 passed (16)
      Tests  135 passed (135)
   Start at  12:48:18
   Duration  4.62s (transform 707ms, setup 0ms, import 1.27s, tests 9.63s, environment 1ms)


(node:366424) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:366428) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
(node:364664) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
stderr | tests/bridgeAgent.test.ts > BridgeAgentService > includes live worker observation in task status
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-164819-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > marks internal task status as orphaned when no running job or worker exists
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-164819-agent-task.

stderr | tests/bridgeAgent.test.ts > BridgeAgentService > explains missing implementation logs while a task is still implementing
Clearing stale pendingUserPrompt from internal workflow state execution_unit_implementing for task 20260525-164820-agent-task.
```
# Execution Unit 01: Main

No verification commands were proposed.

## Known Remaining Issues

**Findings**

No blocking issues found.

Non-blocking packaging note: the new root [README.md](C:/Users/24600/OneDrive/文档/Manager/README.md:1) exists, but `git status --short` shows it as `?? README.md`. Make sure it is included in the final patch/commit, otherwise the root entry point will be omitted.

**Verification**

I reran:
- `npm run build` passed.
- `npm test` passed: 16 files, 139 tests. Existing Node `DEP0190` warnings still appear.
- Required term check with `Select-String` passed; `rg` is not installed in this shell.
- Provider-name check for `DeepSeek|OpenAI|Gemini|Claude` returned 0 matches across `README.md`, `START_HERE.md`, and `.env.example`.
- `git diff -- README.md START_HERE.md` ran, but Git does not show untracked `README.md` in that diff.

The setup guide covers the requested flow in [START_HERE.md](C:/Users/24600/OneDrive/文档/Manager/START_HERE.md:1), including local config copying, `.env.local`, adding projects, Lark bridge startup, project access verification, common errors, and the “Prompt for your coding agent” section.

## Future Follow-ups

None recorded.
