# 新增小白 onboarding 文档和 AI agent 配置指南

## Task Info

| Field | Value |
|---|---|
| Task ID | 20260525-172317-onboarding-ai-agent |
| Title | 新增小白 onboarding 文档和 AI agent 配置指南 |
| Category | Docs / Task Record |
| Status | implemented |
| Execution Mode | single |

## Original Request

# 新增小白 onboarding 文档和 AI agent 配置指南

请基于当前 Manager repo 已完成的 provider-agnostic 配置和 START_HERE，继续补一个面向小白用户和 AI coding agent 的 onboarding 文档。

目标：用户不懂命令行也能知道怎么配置；如果用户不想自己配置，可以把整个 repo 交给 Claude / Codex / 其他 coding agent，让 agent 按文档完成安装。

请新增或更新：
- `START_HERE_FOR_BEGINNERS.md`
- `docs/agent-setup-guide.md`

要求：
1. 小白教程要用非常清楚的步骤说明：
   - 这个项目是什么
   - 用户需要准备什么
   - 怎么复制 local config
   - 怎么填写 `.env.local`
   - 怎么填写 project path
   - 怎么验证 Manager 能读到自己的项目
   - 怎么启动 Lark bridge
2. 文档必须解释常见错误：
   - missing API key
   - config missing
   - project path invalid
   - provider command not found
   - Lark credentials missing
   - Node/npm missing
3. `docs/agent-setup-guide.md` 要告诉 AI agent：
   - 先读哪些文件
   - 需要问用户哪些信息
   - 只能修改哪些 local 文件
   - 不要读取、打印或提交真实 secret
   - 如何运行验证
4. 文档继续保持 provider-agnostic，不要写死某个 LLM provider。
5. 不要重复大段复制 START_HERE，必要时链接到 START_HERE，并补小白解释。

验证：
- README / START_HERE / beginner guide / agent guide 互相链接正确。
- 不出现真实 API key 或本机私密路径。
- `npm run build`
- `npm test`

## Plan Summary

Category: Docs / Task Record

## Queue Summary

Task 01 Main: npm run build: passed, npm test: passed

## Subtask Status

| Subtask | Status |
|---|---|
| [01 - Main](subtasks/01-main.md) | Done |

## Token Usage

Ledger: [token-usage.json](token-usage.json)

No token usage entries recorded yet. Usage is unknown, not zero.

Query usage from this workflow repo: `npm run assistant -- usage --task 20260525-172317-onboarding-ai-agent --by role`

## Test Summary

See `test-build-log.md` and subtask Test Result sections.

## Final Review Status

Pending

## User Acceptance Status

Pending

## Final Completion Status

Pending
