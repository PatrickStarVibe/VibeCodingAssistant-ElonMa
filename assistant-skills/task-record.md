# Universal Task Record Storage

Every approved plan is a parent task. A parent task may have one execution unit or many, but both use the same record structure.

## Task Record Root

`TASK_RECORD_ROOT` is configurable per project with `project.taskRecordRoot`.

If it is missing, VibeCodingAssistant-ElonMa uses:

```text
<project.targetDir>/task
```

For example, this may be:

```text
C:/path/to/your/project/task
```

## Folder Shape

```text
task/
  README.md

  <task-id-or-slug>/
    README.md
    plan.md
    plan-review.md
    implementation-log.md
    final-review.md
    task-record.md

    subtasks/
      01-main.md
      02-xxx.md

    artifacts/
```

Do not store subtask files directly under `task/`.

Do not create category-based folders.

## Category

Category is one lightweight metadata field. It never controls path, execution order, tests, or review policy.

Supported values:

- Reader Core
- Selection / Popup
- Vocabulary Algorithm
- Translation / LLM
- Feedback / User Model
- Storage / Persistence
- Backend / API
- Data / Dictionary Pipeline
- Evaluation / Benchmark
- Assistant / Workflow
- Docs / Task Record
- UI / Frontend
- Other

Architect may suggest Category. VibeCodingAssistant-ElonMa stores it. Missing or unknown Category becomes `Other`.

## Lifecycle Timing

- On task creation, VibeCodingAssistant-ElonMa may initialize `task/<task-id>/` with README and standard placeholder files.
- `plan.md`, `plan-review.md`, and `subtasks/*.md` are formalized only after the plan is reviewed where applicable and approved by the user.
- Single tasks use `subtasks/01-main.md`.
- Decomposed tasks use multiple `subtasks/NN-*.md` files under the same parent task folder.
- `implementation-log.md` and each subtask `Test Result` are updated during execution.
- `final-review.md` is updated after final review.
- `task-record.md` is finalized only after user acceptance.
- `completed` must be impossible before a valid `task-record.md` exists.

## User Acceptance

Final review success moves to `awaiting_user_acceptance`.

Accepted replies:

- `accept`: finalize `task-record.md` and complete.
- `note: <observation>`: record the note and keep waiting.
- `revise: <instruction>`: route back for changes.
