# 修复 Assistant Elon Ma / Lark bridge 动作执行契约

## Task Info

| Field | Value |
|---|---|
| Task ID | 20260525-172200-assistant-elon-ma-lark-bridge |
| Title | 修复 Assistant Elon Ma / Lark bridge 动作执行契约 |
| Category | Other |
| Status | execution_unit_implementing |
| Execution Mode | single |

## Original Request

# 修复 Assistant Elon Ma / Lark bridge 动作执行契约

请修复 Assistant Elon Ma / Lark bridge 的动作执行契约。

目标：
Assistant 的文字回复不能冒充系统动作。任何会推进 workflow、改变 task 状态、记录用户选择、启动/停止后台任务、验收、返工、重新规划、查看 artifact/status 的意图，都必须通过实际 tool call 执行。

核心执行契约：
Assistant 只有两类输出：
1. 纯对话回复 - 只用于解释、翻译、答疑、澄清。 - 不得声称已经记录、提交、推进、验收、重跑、停止或反馈给 workflow。 - 如果没有 tool call，就必须让用户明白 workflow 没有变化。
2. tool call - 任何系统动作都必须用 tool call。 - tool call 成功后，才可以回复"已记录 / 已推进 / 已启动 / 已停止 / 已进入验收"等结果性文字。

如果用户请求了一个动作，但当前没有对应可用 tool：
- 不要假装执行。
- 明确告诉用户：这个动作现在没有可调用的 tool。
- 说明 Assistant 原本想执行什么。
- 列出当前可用的合法动作。
- 告诉用户可以如何继续。

架构要求：
- 不要主要靠 prompt 里的大量状态 if 约束行为。
- 后端应根据当前真实 task/chat 状态生成可用 tools。
- LLM 只能看到当前阶段合法的 tools。
- 非法阶段的工具不要暴露给 LLM。
- 执行层仍要做最后校验，防止旧模型或异常 tool call 误推进。

必须修复的问题：
- 当前 waiting_user_direction 阶段缺少一个"提交用户方向答案"的 tool。
- 因此用户回复 "1" 或解释选择时，Assistant 可能只用文字说"我会反馈给 workflow"，但实际没有推进。
- 或者误调用 accept_task / revise_plan，导致报错或突然 replanning。

期望改动：
- 新增/使用 answer_user_direction 这类 tool，用于提交用户对 pendingUserPrompt 的回答。
- waiting_user_direction 阶段的工具表应暴露 answer_user_direction、show_status、show_artifact、ask_task_question、stop_task 等当前合法工具。
- waiting_user_direction 阶段不应暴露 accept_task、approve_plan、revise_plan 这类不对应当前用户问题的工具。
- awaiting_user_acceptance 阶段才暴露 accept_task。
- ready_for_decision / implementation_approved 阶段才暴露 approve_plan。
- 工具表生成逻辑应集中维护，避免散落在 prompt 里靠自然语言约束。

回复约束：
- 默认中文。
- 如果调用了 tool，就基于 tool 执行结果回复。
- 如果没有调用 tool，不得说"已记录 / 我会推进 / 我会反馈给 workflow"。
- 如果无法执行，要说清楚"没有推进 workflow"，并列出当前可用操作。

测试要求：
- waiting_user_direction + 用户回复 "1"：必须走 answer_user_direction，不能走 accept_task/revise_plan，也不能只 reply_to_user。
- waiting_user_direction 的可用工具表不包含 accept_task、approve_plan、revise_plan。
- 如果 Assistant 试图用纯文本声称已执行动作，但没有 tool call，应被拦截或改写为明确未执行。
- 如果用户请求的动作没有可用 tool，回复必须说明无法执行、缺少对应 tool，并列出当前可用动作。
- 保留正常路径：awaiting_user_acceptance 下 accept_task 仍可验收；ready_for_decision 下 approve_plan 仍可启动实现。

## Plan Summary

Assistant / Workflow

## Queue Summary

Implementing execution unit 1/1.

## Subtask Status

| Subtask | Status |
|---|---|
| [01 - Main](subtasks/01-main.md) | In Progress |

## Token Usage

Ledger: [token-usage.json](token-usage.json)

No token usage entries recorded yet. Usage is unknown, not zero.

Query usage from this workflow repo: `npm run assistant -- usage --task 20260525-172200-assistant-elon-ma-lark-bridge --by role`

## Test Summary

Pending

## Final Review Status

Pending

## User Acceptance Status

Pending

## Final Completion Status

Pending
