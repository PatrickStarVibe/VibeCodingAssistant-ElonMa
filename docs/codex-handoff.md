# Codex Handoff: 驱动 Manager Workflow

你（Codex）从这个文档接手，替代 Claude 来驱动用户的本地 AI coding workflow Manager。本文档自包含——你不需要回看会话历史，但建议先扫一遍 [docs/manager-workflow.md](manager-workflow.md) 了解 Manager 的设计意图。

## 0. 你的角色

你是用户的 workflow 操作员，不是实施者。你的工作是：
- 跑 Manager CLI 命令
- 把 Manager 产出的 brief / explanation 翻译/呈现给用户
- 把用户的回复（中文/语音可能有错）转成正确的 Manager 命令
- 监控长时跑的任务，及时把状态汇报给用户
- **不要**自己去 reader 项目改代码——那是 Manager 内部 Developer 角色的事

## 1. Manager 在哪、能干嘛

Manager 仓库：`C:\Users\24600\OneDrive\文档\Manager`

它是一个独立的本地 Node CLI 工具。角色职能固定为 Manager、Architect、Plan Reviewer、Developer、Final Reviewer；当前默认用 DeepSeek 当 Manager，Codex/Claude 按难度填这些角色。状态机：

```
created
  → briefing                         (Manager 用中文整理需求 brief)
  → awaiting_brief_confirmation      (用户 approve/revise/reject brief)
  → awaiting_difficulty_selection    (用户选择 low/medium/high)
  → planning                         (low: Codex all roles；medium: Codex Architect/Developer + Claude Reviewer；high: Claude Architect/Reviewer + Codex Developer)
  → ready_for_decision               (用户 approve/revise/reject revised plan)
  → implementation_approved
  → implementing                     (Developer 真改 reader 项目)
  → implemented                      (npm test 等验证)
  → final_reviewing                  (Final Reviewer 审 diff)
  → final_review_routing             (Manager 决定 complete / 回 implementer / 回 planner / 问用户)
  → completed | stopped
```

中间任何一步都可能进 `waiting_user_direction`（产品级问题需用户决定）。

## 2. 主要命令速查

工作目录始终是 `C:\Users\24600\OneDrive\文档\Manager`，命令前缀 `npm run manager --`。

```bash
# 创建 task
npm run manager -- create --title "kebab-case-id" --task-file path/to/task.md

# 推进流水线（第一次会停在 brief gate）
npm run manager -- plan --task <task-id>

# 看产出
npm run manager -- show --task <task-id> --artifact manager-brief
npm run manager -- show --task <task-id> --artifact revised-plan
npm run manager -- show --task <task-id> --artifact manager-explanation
npm run manager -- show --task <task-id> --artifact final-report
npm run manager -- status --task <task-id>
npm run manager -- summary --task <task-id>

# 用户回复（短英文回复直接传字符串；长/中文用文件）
npm run manager -- reply --task <task-id> "approve A"
npm run manager -- reply --task <task-id> "reject B"
npm run manager -- reply --task <task-id> --text-file path/to/reply.txt

# 启用真实重型 agent（Codex/Claude CLI）；不加则全是 stub
# 关键：选难度进入 planning（出 initial plan 那步）需要 --allow-agent-calls
# brief 阶段（phase 1）只 Manager 调 DeepSeek，不需要 --allow-agent-calls
npm run manager -- plan --task <task-id> --allow-agent-calls
npm run manager -- reply --task <task-id> "medium" --allow-agent-calls
```

## 3. 用户回复的合法形式

**Brief gate 和 plan gate 都用同一套**：

| 用户语义 | Manager 接受的输入 |
|---|---|
| 同意 | `approve A`、`A`、`yes`、`y`、`同意`、`批准` |
| 拒绝 | `reject B`、`B`、`no`、`n`、`拒绝`、`不同意` |
| 修改 | `revise C: <具体修改>` |
| 选难度 | `low`、`medium`、`high`（只在 `awaiting_difficulty_selection` 接受） |
| 停止 | `stop` |
| 看状态 | `status` |
| 看摘要 | `summary` |

含中文、长文本、带换行的修改指令——**走 `--text-file`**。Bash/cmd.exe 在 Windows 上传中文 CLI 参数会乱码或截断，已经踩过这个坑。

不在白名单的回复（如 `好的`），Manager 会调 DeepSeek 解读并回 "我理解你想 X，请确认"，**不会直接执行**。

## 4. Brief gate 是关键改进

第一次跑 `plan` 不会调 Codex/Claude，只让 DeepSeek 把用户需求整理成中文 brief。用户经常用语音输入，brief gate 是抓识别错误和需求偏差的关口。**省 token 的关键**——如果 brief 不对，revise C 让 DeepSeek 重写，Codex/Claude 一次没动。

`revise C` 在 brief 阶段会**累积**修订到 `briefRevisionRequests` 数组，下次重生 brief 时全部应用，不会忘掉之前的修改。

approve brief 之后不会立刻烧 Codex/Claude，而是停在 `awaiting_difficulty_selection`。把用户选择转成 `low` / `medium` / `high` 之一：`low` 适合文案、颜色、很小的改动，会跳过 plan review，当前默认 Codex 包下全部重型角色；`medium` 是默认旧流程，Codex 做 Architect/Developer，Claude 做 Reviewer；`high` 适合复杂任务，Claude 做 Architect/Reviewer，Codex 做 Developer。以后只改 `workflowRoles` 绑定就能把任意难度的 Developer 换成别的 API。

## 5. 长时跑任务怎么处理

`plan --allow-agent-calls` 和难度选择后的 `reply low|medium|high --allow-agent-calls` 会启动 plan 阶段的重型 agent，可能跑 5-30 分钟。**用后台运行**，不要前台阻塞。

```bash
# 不要这样：前台等不动
npm run manager -- reply --task <id> "medium" --allow-agent-calls

# 这样可以：你看 codex 的 background tools 文档怎么 spawn 后台进程
# 期间隔几分钟读一次 state.json 看 status 字段
```

监控方式：
```bash
# 查状态
cat "C:/Users/24600/OneDrive/文档/Manager/logs/ai-workflow/runs/<task-id>/state.json" | grep status

# 查 reader 项目改了什么（implementing 阶段才有）
cd /e/GameDeveloping/IReader/my-reader && git status --short
```

完成的标志：state.json 的 `status` 变成 `awaiting_brief_confirmation` / `ready_for_decision` / `waiting_user_direction` / `completed` / `stopped` 之一。

## 6. 多任务并发

支持多 task 并行，**只要每条命令都用显式 task ID，不用 latest**。

```bash
# 创建 task A
npm run manager -- create --title "task-a" --task-file ...
# 拿到 task-a-id

# 创建 task B
npm run manager -- create --title "task-b" --task-file ...
# 拿到 task-b-id

# 同时跑（后台 spawn 两个进程）
npm run manager -- plan --task <task-a-id> --allow-agent-calls &
npm run manager -- plan --task <task-b-id> --allow-agent-calls &
```

约束：
- **同一个 task 必须串行**：不能在 task A 上同时 `plan` 和 `reply`，会写崩 state.json
- **跨 task 完全并行**：Codex/Claude CLI 每次调用都是独立进程，OS 层面没问题
- **`logs/ai-workflow/latest-task-id.txt`** 只指向最后 create 的那个，多任务别用 latest

## 7. 已知 bug 和注意事项

**Windows 平台**：
- `runFile` 已经在 Windows 上加了 `shell: true`，能找到 `.cmd` shim（codex.cmd 等）
- DEP0190 警告可忽略（args 数组 + shell:true）。当前没有用户输入直接进 args，不会有 shell 注入风险。但如果未来要把 user-controlled string 拼进 args，需要先过转义
- 中文 CLI 参数走 `--text-file`，别直接传字符串

**Manager 的 prompt**：
- `createRevisionInstructions` 已经修过——当 user 提了 `requestedChanges`，prompt 会明确让 DeepSeek 把用户修改当主、reviewer 反馈当辅
- `structuredText` 和 `routeAfterFinalReview` 都开了 `response_format: json_object`，DeepSeek 会强 JSON

**Codex CLI flag**（在 adapters.ts 已配好）：
- Architect / Plan Reviewer / Final Reviewer: `codex -a never exec -C <dir> --sandbox read-only --skip-git-repo-check -`
- Developer: `codex -a never exec -C <dir> --sandbox danger-full-access --skip-git-repo-check -`

**Claude CLI flag**：
- Architect / Plan Reviewer / Developer / Final Reviewer: `claude -p --permission-mode bypassPermissions --add-dir <dir>`，prompt 走 stdin

**状态机的边界**：
- `waiting_user_direction` 状态接受 `approve A`（视为接受 Manager 推荐答案）和 `revise C`，不接受 implementApproved 直接调用
- `completed` 不能再 revise——必须起新 task

## 8. Reader 项目当前状态

`E:/GameDeveloping/IReader/my-reader/` 当前 dirty。上一个 task `reader-word-feedback-v1` 已经 completed 并被用户部分验收：

**用户验收 OK**：
- 高亮词 hover → translation tooltip 右下角「我认识」按钮 → 点击后高亮消失。这条工作正常

**用户反馈的问题**（这就是 follow-up 任务要解决的）：
- 未高亮词选中 → 显示 Translator（原 popover），但行为不符合预期：不自动翻译、没有 pending 状态、视觉风格和 hover tooltip 不一致
- 点击「标为生词」时，**整个页面所有高亮会闪烁消失约 0.x 秒**，再重新出现。新加的词也变高亮但伴随这个 flicker

**reader 项目里 dirty 的文件清单**：
```
M src/components/Reader.tsx
M src/components/Translator.tsx
M src/hooks/useReader.ts
M src/utils/storage.ts
M src/vocab/__tests__/VocabularyHoverTooltip.test.tsx
M src/vocab/__tests__/epubWordAnchorProvider.test.ts
M src/vocab/__tests__/vocabularyAnnotationTypes.test.ts
M src/vocab/anchors/epubWordAnchorProvider.ts
M src/vocab/debug/readerDebugHook.ts
M src/vocab/ui/VocabularyHoverTooltip.tsx
M src/vocab/ui/vocabularyAnnotationTypes.ts
M src/vocab/ui/vocabularyOverlayController.ts
?? src/components/__tests__/
?? src/services/vocabulary/__tests__/userVocabularyFeedback.test.ts
?? src/services/vocabulary/userVocabularyFeedback.ts
?? src/utils/storage.test.ts
?? src/vocab/__tests__/vocabularyOverlayController.test.tsx
```

不要回滚这些——是已验收功能。

## 9. 接下来要跑的 follow-up 任务

任务规格已经写好：[`tasks/follow-up-feedback-ui.md`](../tasks/follow-up-feedback-ui.md)

执行流程：

```bash
cd /c/Users/24600/OneDrive/文档/Manager

# 1. 创建任务
npm run manager -- create --title "feedback-ui-unification" --task-file tasks/follow-up-feedback-ui.md

# 2. 拿到 task ID（命令输出里有），后续都用这个 ID 不用 latest

# 3. 跑 brief 阶段（不烧 Codex/Claude，几分钱）
npm run manager -- plan --task <task-id>

# 4. 把 brief 翻给用户看
npm run manager -- show --task <task-id> --artifact manager-brief
# → 等用户决定

# 5. 用户 approve A → 进入难度选择 gate
npm run manager -- reply --task <task-id> "approve A"
# → 等用户选择 low / medium / high

# 6. 用户选难度 → 进 plan 阶段（这步开始烧 Codex/Claude，low 除外）
npm run manager -- reply --task <task-id> "medium" --allow-agent-calls
# → 后台运行，5-15 分钟

# 7. plan 完成后看 explanation
npm run manager -- show --task <task-id> --artifact manager-explanation
# → 等用户决定

# 8. 用户 approve A → 进 implement 阶段（10-30 分钟）
npm run manager -- reply --task <task-id> "approve A" --allow-agent-calls

# 9. 完成后看 final report
npm run manager -- show --task <task-id> --artifact final-report
```

## 10. 和用户的交互方式

**主动停下来等用户的时刻**：
- Brief 出来后，呈现给用户决定（approve/revise/reject）
- Plan 阶段如果 Manager 暂停问产品问题，把问题翻给用户
- Revised plan 出来 explanation 后，让用户决定
- Final review 后如果 Manager 不是 `complete`，用 Manager 的 reason 问用户

**自己决定继续的时刻**：
- 任何 background 长时跑步骤——你只需要轮询 state.json，完成了再呈现结果
- 用户回复明确（`approve A` 或 `revise C: ...`）就直接执行

**呈现 brief / explanation 时**：
- 直接 `cat` artifact 内容给用户看，不要自己改写
- 高亮关键决策点（"Manager 抛出了 N 个产品问题：..."）
- 给清晰的下一步选项（approve / revise / reject）

**呈现 revise 选项时**：
- 你可以基于上下文给一份建议（"我推荐选 A，因为..."），但**最终决定让用户做**
- 不替用户拍板产品 / 范围 / UX 决策

## 11. 不要做的事

- 不要直接改 reader 项目代码（`E:/GameDeveloping/IReader/my-reader/`）。Manager 内部 Developer 角色才能改。你的 Codex 实例只跑 Manager CLI
- 不要在 reader 项目里做 `git restore`、`rm -rf` 等破坏操作，除非用户明确指令——本会话已经踩过一次坑（之前 Claude 误删了用户手动加的 obsidian-vault）
- 不要为了赶进度跳过 brief gate 直接 approve A——brief gate 就是省 token 的关键
- 不要假设 Codex/Claude/DeepSeek 总返回合法 JSON。如果 artifact 看起来空或乱，先看 state.json 和 background task 的 stdout/stderr
 
## 12. Universal Task Records

Manager writes internal run artifacts under `logs/ai-workflow/runs/<task-id>/`, but human-facing project task docs belong under the configured target project task record root.

Default:

```text
TASK_RECORD_ROOT = <project.targetDir>/task
```

IReader:

```text
E:/GameDeveloping/IReader/my-reader/task
```

Every task uses:

```text
task/<task-id>/
  README.md
  token-usage.json
  brief.md
  plan.md
  plan-review.md
  implementation-log.md
  final-review.md
  task-record.md
  subtasks/
    01-main.md
```

Single and decomposed tasks use the same parent folder shape. A single task has `subtasks/01-main.md`; a decomposed task has multiple `subtasks/NN-*.md` files. Do not create category folders or put subtasks directly under `task/`.

Category is one metadata field only. Missing or unknown Category becomes `Other`; it never controls folder paths, tests, execution order, or review policy.

Final review success now moves to `awaiting_user_acceptance`. The user must reply `accept` before Manager finalizes `task-record.md` and marks the task `completed`. The user may also reply `note: <observation>` or `revise: <instruction>`.

Token usage questions must be answered from `task/<task-id>/token-usage.json` when present. Use `npm run manager -- usage --task latest --by role` or `npm run task-usage:summarize -- --latest --by step`; do not answer from memory or backfill unverified historical numbers.
