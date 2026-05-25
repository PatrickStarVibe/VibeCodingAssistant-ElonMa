# 修复 Assistant Elon Ma / Lark bridge 动作执行契约

## Task Info

| Field | Value |
|---|---|
| Task ID | 20260525-175810-assistant-elon-ma-lark-bridge |
| Title | 修复 Assistant Elon Ma / Lark bridge 动作执行契约 |
| Category | Other |
| Status | completed |
| Execution Mode | decomposed |

## Original Request

# 修复 Assistant Elon Ma / Lark bridge 动作执行契约

请修复 Assistant Elon Ma / Lark bridge 的动作执行契约。 目标： Assistant 的文字回复不能冒充系统动作。任何会推进 workflow、改变 task 状态、记录用户选择、启动/停止后台任务、验收、返工、重新规划、查看 artifact/status 的意图，都必须通过实际 tool call 执行。 核心执行契约： Assistant 只有两类输出： 1. 纯对话回复 - 只用于解释、翻译、答疑、澄清。 - 不得声称已经记录、提交、推进、验收、重跑、停止或反馈给 workflow。 - 如果没有 tool call，就必须让用户明白 workflow 没有变化。 2. tool call - 任何系统动作都必须用 tool call。 - tool call 成功后，才可以回复"已记录 / 已推进 / 已启动 / 已停止 / 已进入验收"等结果性文字。 如果用户请求了一个动作，但当前没有对应可用 tool： - 不要假装执行。 - 明确告诉用户：这个动作现在没有可调用的 tool。 - 说明 Assistant 原本想执行什么。 - 列出当前可用的合法动作。 - 告诉用户可以如何继续。 架构要求： - 不要主要靠 prompt 里的大量状态 if 约束行为。 - 后端应根据当前真实 task/chat 状态生成可用 tools。 - LLM 只能看到当前阶段合法的 tools。 - 非法阶段的工具不要暴露给 LLM。 - 执行层仍要做最后校验，防止旧模型或异常 tool call 误推进。 必须修复的问题： - 当前 waiting_user_direction 阶段缺少一个"提交用户方向答案"的 tool。 - 因此用户回复 "1" 或解释选择时，Assistant 可能只用文字说"我会反馈"，但不执行 tool call，导致 workflow 卡死。

## Plan Summary

**Category:** Assistant / Workflow

## Queue Summary

All execution units are done.

## Subtask Status

| Subtask | Status |
|---|---|
| [01 - Audit current contract surface (no code change)](subtasks/01-audit-current-contract-surface-no-code-c.md) | Done |
| [02 - Strengthen `FAKE_STATE_CLAIM_PATTERN`](subtasks/02-strengthen-fake-state-claim-pattern.md) | Done |
| [03 - State-aware enforcement for `waiting_user_direction` (Reviewer Finding 1, Blocking)](subtasks/03-state-aware-enforcement-for-waiting-user.md) | Done |
| [04 - Make `replyNoOp` state-aware and directive](subtasks/04-make-replynoop-state-aware-and-directive.md) | Done |
| [05 - Sharpen the `decideBridgeAction` system prompt](subtasks/05-sharpen-the-decidebridgeaction-system-pr.md) | Done |
| [06 - Regression tests (Reviewer Findings 2 and 4)](subtasks/06-regression-tests-reviewer-findings-2-and.md) | Done |

## Token Usage

Ledger: [token-usage.json](token-usage.json)

No token usage entries recorded yet. Usage is unknown, not zero.

Query usage from this workflow repo: `npm run assistant -- usage --task 20260525-175810-assistant-elon-ma-lark-bridge --by role`

## Test Summary

See `test-build-log.md` and subtask Test Result sections.

## Final Review Status

Final review recorded.

## User Acceptance Status

Accepted at 2026-05-25T18:32:58.663Z.

## Final Completion Status

Completed.
