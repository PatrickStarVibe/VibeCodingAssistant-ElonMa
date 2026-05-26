# 分发化：preflight 检查器 + package scripts + Windows 启动 + doc 更新 + hygiene

## Task Info

| Field | Value |
|---|---|
| Task ID | 20260525-191954-preflight-package-scripts-windows-doc-hy |
| Title | 分发化：preflight 检查器 + package scripts + Windows 启动 + doc 更新 + hygiene |
| Category | Other |
| Status | created |
| Execution Mode | Pending |

## Original Request

请继续当前 Manager repo 的分发化工作。Task 1 provider-agnostic 配置和 Task 2 onboarding docs 已经基本完成；不要重复重写它们。请先阅读当前真实代码和文档，再实现下面内容。

## Context
当前已有：
- `README.md`
- `START_HERE.md`
- `START_HERE_FOR_BEGINNERS.md`
- `docs/agent-setup-guide.md`
- `.env.example`
- `assistant.config.example.json`
- provider-agnostic profile/config 结构

当前还缺：
- preflight 检查器
- package scripts
- Windows 双击启动入口
- GitHub 分发前 repo hygiene 检查
- docs 与 scripts 的最终衔接

请不要改 `conversation.ts` / `orchestrator.ts`，不要重构 workflow，不要做 Electron 或复杂 GUI，不要写死任何 provider，不要写死本机绝对路径，不要 git reset。

## Part 0 — Documentation Tightening
先修一个 Task 2 遗留的小问题：
`docs/agent-setup-guide.md` 里如果提到 AI agent 可以 inspect `.env.local`，请改成更安全的表述：
- agent 可以检查 `.env.local` 是否存在。
- agent 可以检查需要的 env var name 是否存在且非空。
- agent 不应该读取、复述、打印、总结、保存或提交真实 secret 值。
- 如果必须写入 secret，应该让用户自己在本地文件中填写，或者只在用户明确授权时写入 `.env.local`，并且不能在输出里回显完整 secret。
不要把真实 key 放进 docs 或 tests。

## Part 1 — Preflight Checker
新增一个 preflight 检查器，用于启动前告诉用户缺什么。

目标命令：
```bash
npm run preflight
npm run preflight -- --config assistant.config.local.json
```

实现要求：
新增 TypeScript CLI，例如 src/preflightCli.ts 或等价位置。
支持 --config <path>，默认检查 assistant.config.local.json。
检查内容：
Node/npm 当前环境可用。
assistant.config.local.json 是否存在。
.env.local 是否存在。
config 能否 load。
profiles.*.apiKeyEnv 引用的 env var 是否存在于 process env 或 .env.local。
Lark app id / app secret env 是否存在。
每个 project 的 targetDir 是否存在且是目录。
command-backed profile 的 command 是否填写，并尽量检查是否可执行或能在 PATH 找到。

错误信息必须面向普通用户：
缺什么。
应该打开哪个文件。
应该添加什么格式。
不要打印真实 API key / app secret / token，只打印 env var name。
不要自动覆盖用户配置。

exit code：
pass = 0
fail = non-zero

输出示例：
Missing API key env var: ASSISTANT_API_KEY
How to fix:
1. Open .env.local
2. Add: ASSISTANT_API_KEY=your_key_here
3. Save and rerun npm run preflight

## Part 2 — Package Scripts
更新 package.json scripts，至少提供：
{
  "preflight": "...",
  "start:lark": "...",
  "start:lark:stub": "..."
}

要求：
start:lark 启动前先跑 preflight；preflight 失败时不要继续启动 bridge。
start:lark:stub 用 --stub-heavy-agents 启动，适合第一次验证。
保留现有 assistant、assistant:lark、build、test。
不要破坏现有 CLI 行为。
文档里的命令要和 package scripts 一致。

## Part 3 — Windows 双击启动入口
新增 Windows 友好的双击启动入口：
start-manager-lark.cmd
可选 start-manager-lark.ps1

要求：
脚本从自身所在目录定位 repo root，不写死绝对路径。
双击后先运行 npm run preflight -- --config assistant.config.local.json。
preflight fail 时：
显示错误。
提示用户查看 START_HERE_FOR_BEGINNERS.md。
窗口不要立刻关闭。
preflight pass 后启动 Lark bridge。
成功时显示：
使用哪个 config。
bridge 正在运行。
不打印真实 secret。
如果 node_modules 缺失或 npm 不可用，提示用户先安装 Node.js / 运行 npm install。
不要做 Electron，不要引入重型依赖。

## Part 4 — Docs Update
更新文档，让用户知道新的启动方式：
README.md
START_HERE.md
START_HERE_FOR_BEGINNERS.md
docs/agent-setup-guide.md

要求：
README 简短说明：
新用户看 beginner guide。
AI agent 看 agent setup guide。
配置后可以运行 npm run preflight。
Windows 用户可以双击 start-manager-lark.cmd。
START_HERE 增加 preflight 和 start scripts。
Beginner guide 增加：
如何运行 preflight。
preflight 常见错误如何修。
如何双击启动。
Agent guide 增加：
agent 应该先跑 preflight。
agent 只能检查 secret env var 是否存在/非空，不能读取或输出真实 secret。
agent 如何解释 preflight 错误。
保持 provider-agnostic，不要写死任何 LLM provider。

## Part 5 — GitHub 分发 Hygiene
检查并补齐 repo hygiene。
要求：
检查 .gitignore 是否覆盖：
.env.local
.env.*.local
assistant.config.local.json
assistant.projects.local.json
Lark bridge state logs / runtime artifacts
task records 中可能包含用户私密内容的目录
保留 example/shareable 文件：
.env.example
assistant.config.example.json
README / START_HERE / beginner guide / agent guide
不要删除用户现有 logs / task / local config。
如果发现疑似敏感文件已经被 git track，只报告建议，不要 destructive 操作。
确认 root README.md 是最终 patch 的一部分，不要遗漏 untracked docs。

## Tests
请新增或更新测试：
preflight 缺 config 时失败，并提示清楚。
preflight 缺 .env.local 时失败或 warning，按设计一致。
preflight 缺 API key env 时失败，且不打印真实 secret。
preflight project path 不存在时失败。
preflight command-backed profile 缺 command 时失败。
preflight pass 时 exit code 为 0。
start script 不包含本机绝对路径。
docs 中新命令和 package scripts 一致。
npm run build 通过。
npm test 通过。

## Constraints
不要引入重型依赖。
不要做 GUI / Electron。
不要自动覆盖用户 local config。
不要打印真实 secret。
不要把 provider 写死。
不要改 workflow / orchestration 核心逻辑。
不要 git reset，不要清理无关 worktree 改动。
用定向修改完成。

## Plan Summary

Pending

## Queue Summary

Pending

## Subtask Status

| Subtask | Status |
|---|---|
| Pending | Pending |

## Token Usage

Ledger: [token-usage.json](token-usage.json)

No token usage entries recorded yet. Usage is unknown, not zero.

Query usage from this workflow repo: `npm run assistant -- usage --task 20260525-191954-preflight-package-scripts-windows-doc-hy --by role`

## Test Summary

Pending

## Final Review Status

Pending

## User Acceptance Status

Pending

## Final Completion Status

Pending
