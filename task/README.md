# Task Records

This folder contains Manager task records grouped by task.

## Token Usage Ledgers

New Manager task folders include a machine-readable `token-usage.json` file that follows [`token-usage.schema.json`](token-usage.schema.json). Treat the ledger as the source of truth for task token/cost questions.

- Store task ledgers at `task/<task-id>/token-usage.json`.
- Record one entry per meaningful role/subtask/step usage event.
- Use `accuracy: "actual"` only when platform/API usage is available.
- Use `accuracy: "estimated"` when token counts or cost are calculated from a documented estimate.
- Use `accuracy: "unknown"` when usage is not exposed.
- Do not backfill fake numbers for historical tasks.
- Query a task with `npm run task-usage:summarize -- --task task/<task-id> --by role`, `--by subtask`, or `--by step`.
- Query the most recently updated ledger with `npm run task-usage:summarize -- --latest`.

<!-- manager-task-records:start -->
## Tasks

| Task | Category | Status | Execution Mode | Summary | Updated |
|---|---|---|---|---|---|
| Pending | Other | Pending | Pending | Pending | Pending |
<!-- manager-task-records:end -->
