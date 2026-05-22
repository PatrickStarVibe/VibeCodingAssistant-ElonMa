# Lark Bridge

The Lark bridge turns Manager into a chat-first workflow agent. You chat with
Manager in Lark; Manager still owns the state machine, artifacts, DeepSeek
manager calls, and Codex/Claude handoffs.

## Conversation Contract

The bridge keeps two responsibilities separate:

- The workflow state machine owns correctness and gate enforcement.
- The Manager LLM owns semantic intent classification and Chinese-first reply composition.

Every bound task-chat message is stripped of Lark mention tokens first, so `@bot 同意` and `同意` are equivalent. The classifier receives the current state and the allowed actions for that state; if the interpreted intent is not allowed, the bridge asks for clarification and does not mutate workflow state.

Workflow gates remain unchanged: brief confirmation, difficulty selection, plan approval, final review routing, and user acceptance.

## Setup

1. Install the official Lark desktop or mobile app.
2. Create a Lark self-built app in the Lark Open Platform and enable bot +
   message events.
3. Grant the app permissions for receiving messages, sending messages, creating
   chats, and uploading files.
4. Set local environment variables:

```powershell
$env:LARK_APP_ID="cli_xxx"
$env:LARK_APP_SECRET="xxx"
```

5. Start the bridge:

```powershell
npm run manager:lark
```

For local smoke runs without Codex/Claude heavy agent calls:

```powershell
npm run manager:lark -- --stub-heavy-agents
```

## Pairing

On first startup the bridge prints a pairing code:

```text
Lark pairing code: 123456
```

Send this to the bot from your Lark account:

```text
/pair 123456
```

The bridge stores your `open_id` in `logs/ai-workflow/lark-bridge-state.json`.
After that, Manager recognizes you without manually editing config.

You can also pre-authorize users in `manager.config.local.json`:

```json
{
  "lark": {
    "allowedOpenIds": ["ou_xxx"],
    "taskMemberOpenIds": ["ou_xxx"]
  }
}
```

## Daily Use

In an unbound/control chat, Manager behaves like a chatbot first. Normal
messages can ask questions, explore an idea, generate a prompt, or refine a
possible workflow. They do not create real tasks automatically.

General control chat receives retrieved project Markdown context too. If a
message mentions a configured project id or name, such as `ireader` or
`IReader`, Manager uses that project when it searches `project-docs/<project>/`.

Task-like messages create a pending proposal instead of a task:

```text
帮我想一下这个 Lark Manager 交互应该怎么改
```

Manager replies with interpreted intent, a suggested title, a suggested task
prompt, what the task would and would not do, and asks whether to create it.

While a proposal is pending, reply:

```text
create task
edit: keep the first version smaller
cancel
```

Direct real task creation is intentionally explicit:

```text
create task: Make the unknown-word popover behave like the vocabulary tooltip.

/create Feedback UI
Make the unknown-word popover behave like the vocabulary tooltip.

new task: Fix hover behavior
```

Prompt-generation and thinking requests such as `帮我写一个 prompt`,
`先帮我整理一下`, `先不要创建 task`, and `不要执行` produce normal Manager
chat output. They may suggest a task as a follow-up, but they never create one
automatically.

The bridge creates a task in Manager, creates a task-specific Lark chat, binds
that chat to the task ID, and starts brief generation only after explicit
creation or proposal confirmation.

Inside the task chat, reply naturally:

```text
同意
走默认难度
高难度吧
这里先别扩大范围
这个方案最大的风险在哪里？
验收通过
/show revised-plan
```

`/show <artifact>` remains an explicit command because it retrieves a file. Other task-chat messages, including status checks, summaries, stop requests, approvals, revisions, difficulty choices, notes, and acceptance, go through LLM intent classification.

Task chats are conversational by default. Natural-language questions such as
`这个 plan 是什么意思？`, `A 和 B 有什么区别？`, `帮我解释这个 plan`, or
`请解释第二点` are routed to Manager Q&A using the current task artifacts as
context. To create a separate task from inside a task chat, use an explicit
command: `create task: ...`, `new task: ...`, or `/create ...`.

Single-letter replies are no longer special in production task chats. If the classifier cannot confidently understand a message, or if the intent is not legal for the current gate, the bridge asks for clarification instead of mutating the workflow.

In an unbound chat, `status` and `summary` also show a pending proposal when one
exists, including the available replies: `create task`, `edit: <instruction>`,
and `cancel`.

If there is no pending proposal and you reply `confirm`, `create task`, or
`edit: ...`, Manager asks for clarification instead of creating or changing
anything.

If the bridge cannot classify a task-chat message, it replies in Chinese and asks for a clearer natural-language decision or question. It does not advance the task until classification is confident and allowed by the current gate.

Every task chat is bound to one explicit task ID. The bridge never uses
`latest`, so multiple tasks can run in parallel without cross-routing.

## State And Artifacts

Bridge state lives at:

```text
logs/ai-workflow/lark-bridge-state.json
```

Manager task artifacts still live at:

```text
logs/ai-workflow/runs/<task-id>/
```

When a task reaches brief, decision, user-direction, user-acceptance, completed, or stopped states, the bridge sends a short Chinese-first message and attaches the relevant Markdown artifact.

The bridge records a reminder hash per task. If the status and pending prompt have already been sent, the watcher suppresses the duplicate full pending notification instead of repeating the same block.
