# Task Records
This folder contains implementation records grouped by task.
## Token Usage Ledgers
New assistant task folders include a `token-usage.json` file for machine-readable token and cost accounting.
- Treat the ledger as the source of truth for token/cost questions.
- Record usage by role, subtask, and step when usage is available.
- Use `accuracy: "actual"` only for platform/API usage, `estimated` for documented estimates, and `unknown` when usage is not exposed.
- Do not backfill fake numbers for historical tasks.
<!-- assistant-task-records:start -->
## Tasks
| Task | Category | Status | Execution Mode | Summary | Updated |
|---|---|---|---|---|---|
| [Provider-agnostic 配置层整理](20260525-042725-provider-agnostic/README.md) | Other | created | Pending | Pending | 2026-05-25T04:27:25.193Z |
| [Provider-agnostic 配置层整理 (low)](20260525-044247-provider-agnostic-low/README.md) | Assistant / Workflow | execution_unit_implementing | single | Category: Assistant / Workflow | 2026-05-25T05:12:41.232Z |
| [Provider-agnostic 配置层整理 (low)](20260525-161044-provider-agnostic-low/README.md) | Other | awaiting_user_acceptance | single | **Parent Task**<br>Provider-agnostic 配置层整理 | 2026-05-25T16:25:51.672Z |
| [为 Manager 项目新增 setup README](20260525-162237-manager-setup-readme/README.md) | Other | completed | single | **Category:** Docs / Task Record | 2026-05-25T17:23:04.222Z |
| [新增小白 onboarding 文档和 AI agent 配置指南](20260525-172317-onboarding-ai-agent/README.md) | Docs / Task Record | implemented | single | Category: Docs / Task Record | 2026-05-25T17:30:35.698Z |
| [修复 Assistant Elon Ma / Lark bridge 动作执行契约](20260525-172200-assistant-elon-ma-lark-bridge/README.md) | Other | execution_unit_implementing | single | Assistant / Workflow | 2026-05-25T17:51:21.485Z |
| [修复 Assistant Elon Ma / Lark bridge 动作执行契约](20260525-175810-assistant-elon-ma-lark-bridge/README.md) | Other | completed | decomposed | **Category:** Assistant / Workflow | 2026-05-25T18:32:58.671Z |
| [新增 extra high difficulty 档位及多轮 Plan 打磨机制](20260525-180600-extra-high-difficulty-plan/README.md) | Assistant / Workflow | execution_unit_implementing | decomposed | Category: Assistant / Workflow | 2026-05-25T18:35:08.241Z |
<!-- assistant-task-records:end -->
