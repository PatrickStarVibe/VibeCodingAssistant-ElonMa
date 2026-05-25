# 为 Manager 项目新增 setup README

## Task Info

| Field | Value |
|---|---|
| Task ID | 20260525-162237-manager-setup-readme |
| Title | 为 Manager 项目新增 setup README |
| Category | Other |
| Status | completed |
| Execution Mode | single |

## Original Request

# 为 Manager 项目新增 setup README

请为 Manager 项目新增一个面向"用户自己的 AI coding assistant"的 setup README。 目标： 让使用者把 repo 下载后，知道需要准备哪些信息，并能把自己的 API / Lark / 项目路径配置进去。 请新增或更新 README / START_HERE，内容包括： 1. 用户需要准备的信息： - 一个或多个项目的本地路径 - Lark/飞书 app credentials 或其他 chat bridge credentials - 想使用的 LLM provider 和 API key env name - 各角色使用哪个 profile 2. 如何复制 example config 到 local config。 3. 如何填写 `.env.local`。 4. 如何添加新 project。 5. 如何启动 Lark bridge。 6. 如何确认 Elon Ma 能访问用户自己的项目目录。 7. 常见错误： - API key missing - provider command not found - project path invalid - Lark 权限不对 8. 文档必须 provider-agnostic，不要写死 DeepSeek / OpenAI / Gemini / Claude 任一方。 额外要求： 加一个 "Prompt for your coding agent" 小节，告诉用户可以把哪些信息发给自己的 Claude/Codex/其他 coding agent，让 agent 帮他完成配置。

## Plan Summary

**Category:** Docs / Task Record

## Queue Summary

All execution units are done.

## Subtask Status

| Subtask | Status |
|---|---|
| [01 - Main](subtasks/01-main.md) | Done |

## Token Usage

Ledger: [token-usage.json](token-usage.json)

No token usage entries recorded yet. Usage is unknown, not zero.

Query usage from this workflow repo: `npm run assistant -- usage --task 20260525-162237-manager-setup-readme --by role`

## Test Summary

See `test-build-log.md` and subtask Test Result sections.

## Final Review Status

Final review recorded.

## User Acceptance Status

Accepted at 2026-05-25T17:23:04.215Z.

## Final Completion Status

Completed.
