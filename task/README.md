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
| [Provider-agnostic 配置层整理 (low)](20260525-161044-provider-agnostic-low/README.md) | Other | implemented | single | **Parent Task**<br>Provider-agnostic 配置层整理 | 2026-05-25T16:21:03.330Z |
| [为 Manager 项目新增 setup README](20260525-162237-manager-setup-readme/README.md) | Other | created | Pending | Pending | 2026-05-25T16:22:37.836Z |
<!-- assistant-task-records:end -->
