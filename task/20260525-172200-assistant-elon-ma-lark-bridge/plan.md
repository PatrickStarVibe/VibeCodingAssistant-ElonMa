# Bridge Action Execution Contract — Revised Plan

## Category

Assistant / Workflow

## Goal

Stop Assistant Elon Ma from "lying" about workflow progress through plain-text replies. Every state-changing claim must be backed by a real tool call, and the bridge layer must enforce this even when the LLM tries to fake it. Tool exposure must be status-driven, AND the execution layer must do a final state-vs-tool check before any background workflow call.

## Current State (already in place — do not redo)

- `answer_user_direction` exists in `BridgeToolName`, `bridgeTools()`, and `executeTool` (`src/bridgeAgent.ts:256-259`, `src/adapters.ts:468-478`).
- `WAITING_USER_DIRECTION_TOOL_NAMES` already excludes `accept_task`, `approve_plan`, `revise_plan` (`src/adapters.ts:290-298`).
- `executeTool` already redirects stale `accept_task` / `revise_plan` in `waiting_user_direction` to `answerUserDirection` (`src/bridgeAgent.ts:241-269`).
- Tests at `tests/adapters.test.ts:347-370` and `tests/bridgeAgent.test.ts:282-343` already cover the waiting-direction tool gate and routing.
- Workflow `revise` legality: `awaiting_user_acceptance` (post-final-review revision branch, `src/workflow.ts:362-376`) and `ready_for_decision` / `waiting_user_direction` (`src/workflow.ts:377-389`); not legal in `implementation_approved` (`src/workflow.ts:399`).

## Gaps (this plan addresses every blocking finding)

1. Tool gate is chat-kind-shaped, not status-shaped — `ACTIVE_PROJECT_CHAT_TOOL_NAMES` simultaneously exposes `choose_difficulty`, `approve_plan`, `accept_task`, `revise_plan` regardless of status.
2. No execution-layer state validation — even if tool gating is fixed, a stale/anomalous `approve_plan` tool call in `awaiting_user_acceptance` would still go through `workflow.reply('approve A')` which then hits the `awaiting_user_acceptance` branch in `src/workflow.ts:392-394` and **completes the task as accepted**. This is the central risk the reviewer flagged.
3. No interception of fake completion claims in `kind: 'reply'` or `reply_to_user`.
4. System prompt does not spell out the "no tool call → no state claim" contract.
5. `bridgeToolNamesForInput` falls back to `IDLE_PROJECT_CHAT_TOOL_NAMES` (which contains `create_task`) when `input.task` failed to load but `input.chat.boundTaskId` is set — bound-task chat could be tricked into accepting a new `create_task`.
6. No deterministic helper for "user asked for an action with no tool" — relying solely on LLM prompt is insufficient.
7. `bridgeNextStep` lumps `waiting_user_direction` with `ready_for_decision` and tells the user to `approve / 改哪里` even when the actual next step is to answer the pending prompt.
8. `revise_plan` in `awaiting_user_acceptance` is wrapped as a `'replanning'` background label, which prints "我开始 replanning" — but the workflow path actually re-queues the approved implementation route. The started message is misleading.

## Execution Unit (single)

**Files**: `src/adapters.ts`, `src/bridgeAgent.ts`, `tests/adapters.test.ts`, `tests/bridgeAgent.test.ts`.

### a. Status-driven tool sets (`src/adapters.ts`)

Replace `ACTIVE_PROJECT_CHAT_TOOL_NAMES` with five named sets keyed to `TaskState['status']`. Aligned with `src/workflow.ts` legality:

- `DIFFICULTY_GATE_TOOL_NAMES` → `created`, `awaiting_difficulty_selection`: `reply_to_user`, `choose_difficulty`, `stop_task`, `ask_task_question`, `show_status`, `show_artifact`, `list_projects`.
- `READY_FOR_DECISION_TOOL_NAMES` → `ready_for_decision`: `reply_to_user`, `approve_plan`, `revise_plan`, `stop_task`, `ask_task_question`, `show_status`, `show_artifact`, `list_projects`.
- `IMPLEMENTATION_APPROVED_TOOL_NAMES` → `implementation_approved`: `reply_to_user`, `stop_task`, `ask_task_question`, `show_status`, `show_artifact`, `list_projects`. **No `revise_plan`** — workflow rejects it from this state. Approval already happened, so no `approve_plan` either.
- `AWAITING_USER_ACCEPTANCE_TOOL_NAMES` → `awaiting_user_acceptance`: `reply_to_user`, `accept_task`, `revise_plan`, `stop_task`, `ask_task_question`, `show_status`, `show_artifact`, `list_projects`. (`revise_plan` is the documented post-final-review revision path; it is a legal product action.)
- `WAITING_USER_DIRECTION_TOOL_NAMES` — keep as-is.
- `IN_FLIGHT_TASK_TOOL_NAMES` → all in-flight statuses (`planning_requested`, `planning`, `implementing`, `execution_unit_*`, `final_reviewing`, `task_recording`, `task_artifacts_persisting`, `final_review_routing`, `next_execution_unit_or_all_done`, `implemented`, `execution_queue_ready`): `reply_to_user`, `stop_task`, `ask_task_question`, `show_status`, `show_artifact`, `list_projects`.
- Terminal statuses (`completed`, `stopped`): treat as bound-task with no advancement; tool set = `IN_FLIGHT_TASK_TOOL_NAMES` minus `stop_task`. (Bound-task safety, point e below.)

Add a single `bridgeToolNamesForTaskStatus(status)` helper so the mapping is centralized.

### b. Bound-task safety in `bridgeToolNamesForInput` (`src/adapters.ts:600`)

New dispatch order:

1. If `input.chat.chatKind === 'control'` → `CONTROL_BRIDGE_TOOL_NAMES`.
2. If `input.task?.status` is set → return `bridgeToolNamesForTaskStatus(input.task.status)`.
3. Else if `input.chat.boundTaskId` is set (project chat with bound task but state load failed) → return a conservative `BOUND_TASK_FALLBACK_TOOL_NAMES`: `reply_to_user`, `stop_task`, `ask_task_question`, `show_status`, `show_artifact`, `list_projects`. **Never `create_task`, never any advancement verb.**
4. Else if `input.chat.chatKind === 'project'` and no bound task → `IDLE_PROJECT_CHAT_TOOL_NAMES`.
5. Fallback → `BRIDGE_TOOL_NAMES`.

### c. Centralized execution-layer state validation (`src/bridgeAgent.ts`)

New private method `assertToolAllowedForState(toolName, state)` that returns either `{ ok: true }` or `{ ok: false, reason: string }`. Used **before** any `workflowBackground` / `workflow.reply` / `answerUserDirection` call, for every workflow-touching tool: `choose_difficulty`, `approve_plan`, `accept_task`, `answer_user_direction`, `revise_plan`.

Mapping (mirrors workflow's own legality, not just the tool gate):

| tool | legal `state.status` |
|---|---|
| `choose_difficulty` | `created`, `awaiting_difficulty_selection` |
| `approve_plan` | `ready_for_decision` |
| `accept_task` | `awaiting_user_acceptance` |
| `answer_user_direction` | `waiting_user_direction` |
| `revise_plan` | `ready_for_decision`, `waiting_user_direction`, `awaiting_user_acceptance` |

Existing stale-`accept_task` / stale-`revise_plan` → `answerUserDirection` redirects (when actual status is `waiting_user_direction`) **stay**; they're a graceful fallback the user prompt explicitly mandates. Add the symmetric `approve_plan` redirect: when `state.status === 'waiting_user_direction'`, route to `answerUserDirection(taskId, optionalString(toolCall, 'instruction') ?? request.text)`.

For every other illegal state combination, do NOT call `workflowBackground`. Return a deterministic reply via a new helper `replyNoOp(state, intendedTool, reason)` (see d below) instead.

This means `executeTool`'s `choose_difficulty` and `approve_plan` cases must load `state` first (they currently don't), then run `assertToolAllowedForState` before `workflowBackground`. Symmetric to how `accept_task` and `revise_plan` already load state.

### d. Deterministic "no-op / no available tool" helper (`src/bridgeAgent.ts`)

New `replyNoOp(state, intendedAction, reason)` returning a `kind: 'reply'` turn whose text is fixed-shape:

```
我没有调用任何 workflow 工具，所以 workflow 实际上没有变化。
原本想做的：<intendedAction>
不能执行的原因：<reason>
当前阶段（<state.status>）下你可以：
- <tool 1 user-facing label>
- <tool 2 user-facing label>
...
```

Tool-name → user label mapping built from a single `BRIDGE_TOOL_USER_LABELS` table (e.g., `accept_task → "验收当前 task（accept_task）"`, `answer_user_direction → "回答 pending 问题（answer_user_direction）"`). Reuse descriptions where possible. Set `auditAction: 'guard:state-mismatch'` (or `'guard:no-tool'` when called from the fake-claim guard's "no tool exists" branch).

This helper is invoked by:

- `assertToolAllowedForState` rejection.
- The fake-claim guard (e e e below) when the intended action has no current legal tool.

### e. Fake-claim guard for both reply paths (`src/bridgeAgent.ts:122` area)

Apply to BOTH:

- `decision.kind === 'reply'` (direct text reply from the LLM).
- `decision.kind === 'tool_call'` with `toolCall.name === 'reply_to_user'` (the text inside the tool args).

Detector: `isFakeStateClaim(text: string): boolean`, exported for tests. Regex (Chinese + safety on common phrasings):

```
/已记录|已推进|已启动|已停止|已进入验收|已验收|已批准|已通过|已接受|已反馈给.*?(workflow|工作流)|我会推进|我会反馈给.*?(workflow|工作流)|工作流.*?已|流程.*?已推进|已经推进|帮你推进/
```

If matched, replace the outgoing reply text with `replyNoOp(state, inferredIntent, '没有调用 workflow 工具')`. If `state` is undefined (e.g. control chat with no bound task), build the action list from `bridgeToolNamesForInput(input)` and skip the `state.status` line.

`auditAction: 'guard:fake-claim'`. We do NOT preserve the rejected text in the turn (kept as a string-only audit field for now); the original text remains in the underlying decision object's logging path that already exists. This is documented inline in the helper.

### f. System-prompt hardening (`src/adapters.ts:849-870`)

Add three bullets to `decideBridgeAction` system content:

- "If you do not call a tool, your text MUST NOT claim that anything was recorded, advanced, accepted, approved, stopped, started, routed, or fed back to the workflow. Plain replies are explanation, translation, Q&A, or clarification only."
- "If the user asks for an action that has no available tool in the current state, do not pretend to do it. Say plainly that you cannot execute it, name what you would have done, and list the available tools for the current state."
- "When task.status is waiting_user_direction, answer the pendingUserPrompt with answer_user_direction. Never use approve_plan, accept_task, or revise_plan to acknowledge a numbered choice; those tools are not even available in this state."

### g. Fix `bridgeNextStep` for `waiting_user_direction` (`src/bridgeAgent.ts:681-700`)

Split the `case 'ready_for_decision' / 'waiting_user_direction':` arm. `waiting_user_direction` returns:

```
下一步：回答上面的待决定问题（answer_user_direction）。如果还需要时间或要补充信息，可以先继续提问。
```

`ready_for_decision` keeps existing approve/revise hint.

### h. Fix `revise_plan` started message in `awaiting_user_acceptance` (`src/bridgeAgent.ts:266-269`)

When `revise_plan` is called and `state.status === 'awaiting_user_acceptance'`, do not use the `workflowBackground` path with label `'replanning'`. Instead call `workflow.reply(taskId, 'revise C: ...')` directly (which transitions to `implementation_approved` per `src/workflow.ts:362-376`) and return a `kind: 'reply'` turn with the workflow message. Use `auditAction: 'tool:revise_plan'`.

For other legal statuses (`ready_for_decision`, `waiting_user_direction`), preserve current behavior (background with label `'replanning'` is accurate there because the workflow re-plans).

### i. Tests

`tests/adapters.test.ts` — extend the existing gate suite:

- `awaiting_user_acceptance` → tools include `accept_task`, `revise_plan`; exclude `approve_plan`, `choose_difficulty`.
- `ready_for_decision` → tools include `approve_plan`, `revise_plan`; exclude `accept_task`, `choose_difficulty`.
- `awaiting_difficulty_selection` → tools include `choose_difficulty`; exclude `approve_plan`, `accept_task`, `revise_plan`.
- `implementation_approved` → tools exclude `revise_plan`, `approve_plan`, `accept_task`, `choose_difficulty`; retain `stop_task`, `show_status`, `show_artifact`, `ask_task_question`.
- `implementing` (in-flight) → tools exclude all advancement verbs; retain `stop_task`, `show_status`, `show_artifact`, `ask_task_question`, `list_projects`, `reply_to_user`.
- **Bound-task safety**: project chat with `boundTaskId` set, `task` undefined → tool set is `BOUND_TASK_FALLBACK_TOOL_NAMES`; does **not** contain `create_task`, `choose_difficulty`, `approve_plan`, `accept_task`, `revise_plan`, `answer_user_direction`.

`tests/bridgeAgent.test.ts` — new cases:

1. `waiting_user_direction` + LLM returns `kind: 'reply'` text "我会推进 workflow，已记录你的选择" → bridge rewrites to deterministic `replyNoOp` text containing "未推进 workflow" and the `waiting_user_direction` action list (must mention `answer_user_direction`); `auditAction === 'guard:fake-claim'`; task status remains `waiting_user_direction`.
2. `waiting_user_direction` + LLM returns `reply_to_user` tool with same fake text → same rewrite outcome.
3. `waiting_user_direction` + LLM returns stale `approve_plan` tool call → routed to `answerUserDirection`; status becomes `awaiting_user_acceptance` (mirror of existing `accept_task` test path) — verifies the new symmetric redirect.
4. `awaiting_user_acceptance` + LLM returns stale `approve_plan` tool call → `assertToolAllowedForState` rejects it; bridge returns `replyNoOp` with `auditAction === 'guard:state-mismatch'`; task is **NOT** advanced to `completed` (regression guard for the central risk).
5. `awaiting_user_acceptance` + `revise_plan` legal path → `workflow.reply('revise C: …')` is called; the started message is the workflow result text, NOT `"我开始 replanning"`; `auditAction === 'tool:revise_plan'`.
6. `awaiting_user_acceptance` + valid `accept_task` → still completes (regression for the existing happy path).
7. **No-tool deterministic fallback**: in `implementation_approved`, LLM returns a `revise_plan` tool call → `assertToolAllowedForState` rejects it; reply is `replyNoOp(...)` text listing `stop_task` / `show_status` / `ask_task_question` (no `revise_plan` mentioned); `auditAction === 'guard:state-mismatch'`.
8. `bridgeNextStep` for `waiting_user_direction` (test via `show_status`) returns the new `回答上面的待决定问题` line and does NOT mention "approve" or "改哪里".
9. `isFakeStateClaim` unit test: positive matches for "已记录", "我会推进 workflow", "已进入验收", "已停止"; negative matches for benign "已读你的消息", "我可以解释这个选项".

## Out of Scope

- Refactoring `WorkflowService` state-machine itself.
- Changing how `pendingUserPrompt` text is generated.
- Control Chat / `handleControlChat` flow — bridge-side only.
- Persisting full guard-rejected text in the audit trail (string `auditAction` is sufficient for now; documented in code comment).
- Adding a "second-chance" LLM round-trip when the guard fires; one rewrite to deterministic text is enough.

## Verification Commands

- `npm run lint`
- `npm run build`
- `npm test`
