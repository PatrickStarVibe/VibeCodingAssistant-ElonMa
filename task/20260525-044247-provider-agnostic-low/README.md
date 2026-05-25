# Provider-agnostic 配置层整理 (low)

## Task Info

| Field | Value |
|---|---|
| Task ID | 20260525-044247-provider-agnostic-low |
| Title | Provider-agnostic 配置层整理 (low) |
| Category | Assistant / Workflow |
| Status | execution_unit_implementing |
| Execution Mode | single |

## Original Request

# Provider-agnostic 配置层整理 (low)

请阅读当前 Manager 项目架构，做一个 provider-agnostic 的配置整理。 目标： - 不把任何 API Key 写进 repo。 - 用户可以使用 OpenAI、DeepSeek、Gemini、Claude 或其他兼容 provider。 - `assistant.config.example.json` 和 `.env.example` 要清楚展示需要哪些字段。 - 本地真实配置继续走 `.env.local` / `assistant.config.local.json` / 环境变量，不提交。 要求： 1. 检查当前 config/profile 结构，确认 assistant / architect / planner / developer / reviewer / finalReviewer 等角色如何配置 provider。 2. 示例配置不能写死 DeepSeek，也不能假设用户一定用 Codex 或 Claude。 3. 支持每个 profile 配置： - kind/provider - model - baseUrl 可选 - apiKeyEnv - command 可选 4. 缺少 key 或 command 时，要给用户明确错误信息。 5. 更新 `.gitignore`，确保 local config、env、runtime state、logs 中的敏感内容不被提交。 6. 补测试：example config 可 load；缺失 key 的错误可读；不会要求固定 provider。 不要改 workflow 逻辑，不要引入新 provider SDK；只整理配置层和文档示例。

难度：low

## Plan Summary

Category: Assistant / Workflow

## Queue Summary

Implementing execution unit 1/1.

## Subtask Status

| Subtask | Status |
|---|---|
| [01 - Main](subtasks/01-main.md) | In Progress |

## Token Usage

Ledger: [token-usage.json](token-usage.json)

No token usage entries recorded yet. Usage is unknown, not zero.

Query usage from this workflow repo: `npm run assistant -- usage --task 20260525-044247-provider-agnostic-low --by role`

## Test Summary

See `test-build-log.md` and subtask Test Result sections.

## Final Review Status

Final review recorded.

## User Acceptance Status

Pending

## Final Completion Status

Pending
