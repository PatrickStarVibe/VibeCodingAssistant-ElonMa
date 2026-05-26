# 分发化：preflight + scripts + Windows 启动 + docs 衔接（第3轮）

## Task Info

| Field | Value |
|---|---|
| Task ID | 20260526-043102-preflight-scripts-windows-docs-3 |
| Title | 分发化：preflight + scripts + Windows 启动 + docs 衔接（第3轮） |
| Category | Other |
| Status | completed |
| Execution Mode | decomposed |

## Original Request

# 分发化：preflight + scripts + Windows 启动 + docs 衔接（第3轮）

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
- agent 可以检查需要的 env var name 是否存在（不读值）。
- 如果要读取值，必须先获得用户明确许可。

## Part 1 — Preflight Checker
目标：在 `scripts/` 下创建 `preflight.mjs`，用于 launch 前检查环境是否就绪。

检查项（每一项使用 clear 的 pass/fail 输出，emoji 可选）：
1. Node.js version >= 18
2. `.env.local` 存在，包含 `MANAGER_API_KEY`、`MANAGER_AGENT_ID`、`LARK_APP_ID`、`LARK_APP_SECRET`
3. (条件性) 如果 `assistant.config.json` 中某个 profile 有 command 字段，检查对应命令是否在 PATH 中
4. (条件性) 如果 profile 有 npmScript 字段，检查对应的 npm script 是否存在
5. 输出汇总：✅ 全部通过 / ❌ N 项失败

设计约束：
- 纯 ESM，无外部依赖（允许 `node:fs`、`node:path`、`node:process`、`node:child_process`）
- 不要写死 `.env` 文件路径，接受可选的 `--env-file` 参数
- 输出 human-readable 到 stdout，同时返回 exit code（0 = 通过，1 = 失败）
- 提供 `--json` 参数输出 JSON 格式结果

## Part 2 — Package Scripts
在 `package.json` 中补充/创建以下 scripts：
- `"assistant:preflight"` → `node scripts/preflight.mjs`
- `"assistant:start"` → `node scripts/preflight.mjs && npm run assistant:lark`
- `"assistant:setup"` → 引导式第一运行设置（见 Part 4）
- `"assistant:doctor"` → preflight + 额外诊断信息
- `"prepublishOnly"` → `npm run assistant:preflight`

## Part 3 — Windows Double-Click Entry
在根目录创建 `start-assistant.bat`：
- 检测 Node.js
- 运行 preflight
- 如果通过，运行 `npm run assistant:start`
- 暂停以便查看错误
- 纯 batch，无 PowerShell 依赖

同时创建 `start-assistant.ps1`（给更现代的 Windows 用户）：
- 同样的逻辑，但更 robust
- 使用 `Write-Host` 彩色输出

## Part 4 — Setup Wizard
在 `scripts/` 下创建 `setup.mjs`：
- 交互式 CLI 向导，引导用户完成首次配置
- 步骤：
  1. 检查 Node.js 版本
  2. 引导创建 `.env.local`（提问各字段值）
  3. 引导选择或创建 profile
  4. 运行 preflight 验证
  5. 输出配置摘要
- 设计约束：纯 ESM + `node:readline`，无外部依赖；支持 `--non-interactive` 模式用于 CI

## Part 5 — Repo Hygiene Check
在 `scripts/` 下创建 `repo-hygiene.mjs`：
- 检查是否在 git repo 中
- 检查是否有未提交的更改
- 检查 `.gitignore` 是否包含 `node_modules/`、`.env.local`、`.env`
- 检查 `package-lock.json` 是否存在
- 检查是否有 `package.json` 中的 version bump 提示
- 输出 JSON（--json）或 human-readable
- 用作 CI gate 和 publish 前检查

## Part 6 — Docs & Scripts Convergence
更新或补充以下文档引用：
- `START_HERE.md`：添加指向 setup wizard 和 preflight 的链接/说明
- `docs/agent-setup-guide.md`：补充 preflight 和 setup 的用法说明
- 确保所有新增脚本有 JSDoc/顶部注释说明用途

## 全局约束
- 不改 `conversation.ts`、`orchestrator.ts`、已有 provider 配置的核心逻辑
- 不引入新的 npm 依赖（尤其不要 axios、dotenv、chalk 等）
- 不写死本机绝对路径
- 所有新文件要有顶部注释说明作用和作者信息
- 所有输出信息使用中英双语或纯英文（保持一致性）
- 代码风格：ESM + async/await + 有意义的错误消息

## Plan Summary

Add launch-readiness tooling and Windows entry points so a fresh user can clone, configure, and start Manager without reading source. **No new runtime dependencies. No edits to `conversation.ts` / `orchestrator.ts`. No hard-coded provider names or absolute paths.** Required env-var names are derived dynamically from `assistant.config*.json` (per user direction A).

## Queue Summary

All execution units are done.

## Subtask Status

| Subtask | Status |
|---|---|
| [01 - Documentation tightening (Part 0)](subtasks/01-documentation-tightening-part-0.md) | Done |
| [02 - Shared core helper (`scripts/lib/preflightCore.mjs`)](subtasks/02-shared-core-helper-scripts-lib-preflight.md) | Done |
| [03 - Package scripts (Part 2)](subtasks/03-package-scripts-part-2.md) | Done |
| [04 - Preflight checker (Part 1)](subtasks/04-preflight-checker-part-1.md) | Done |
| [05 - Setup wizard (Part 4)](subtasks/05-setup-wizard-part-4.md) | Done |
| [06 - Repo hygiene check (Part 5)](subtasks/06-repo-hygiene-check-part-5.md) | Done |
| [07 - Windows launchers (Part 3)](subtasks/07-windows-launchers-part-3.md) | Done |
| [08 - Automated tests](subtasks/08-automated-tests.md) | Done |
| [09 - Docs & scripts convergence (Part 6)](subtasks/09-docs-scripts-convergence-part-6.md) | Done |

## Token Usage

Ledger: [token-usage.json](token-usage.json)

No token usage entries recorded yet. Usage is unknown, not zero.

Query usage from this workflow repo: `npm run assistant -- usage --task 20260526-043102-preflight-scripts-windows-docs-3 --by role`

## Test Summary

See `test-build-log.md` and subtask Test Result sections.

## Final Review Status

Final review recorded.

## User Acceptance Status

Accepted at 2026-05-26T21:27:03.094Z.

## Final Completion Status

Completed.
