# Codex 入口：从这里开始

如果你（Codex）刚被用户拉进来接管这个 assistant workflow，**先读两个文件**：

1. [docs/codex-handoff.md](docs/codex-handoff.md) — 你的角色、Assistant 操作手册、并发多任务、已踩的坑
2. [tasks/follow-up-feedback-ui.md](tasks/follow-up-feedback-ui.md) — 当前要跑的 follow-up 任务规格

读完以后第一件要做的事：

```bash
cd <assistant-workspace>
npm run assistant -- create --title "feedback-ui-unification" --task-file tasks/follow-up-feedback-ui.md
```

然后跑 `plan`（不带 `--allow-agent-calls`，因为 brief 阶段只用 DeepSeek，几分钱就出来）：

```bash
npm run assistant -- plan --task <task-id-from-create>
```

把 brief 拿给用户看，等用户决定。后续按 [docs/codex-handoff.md](docs/codex-handoff.md) 的第 9 节执行流程走。

## 已踩过的坑（避免重复）

1. Windows 上 Bash 传中文 CLI 参数会乱码 → 任何含中文/换行的 reply 都走 `--text-file`
2. `--task latest` 在多任务并行时会指向最后 create 的那个 → 多任务请显式传 task ID
3. 不要在 reader 项目（`E:/GameDeveloping/IReader/my-reader/`）里直接 `git restore` 或 `rm -rf`，除非用户明确指令——上次会话误删了用户手动加的 obsidian-vault
4. 重型 agent 跑很久，永远后台运行，定时轮询 `state.json` 的 `status` 字段
5. 第一次跑 plan 在 brief gate 停下来是**预期行为**，不是 bug
