# VibeCodingAssistant-ElonMa

## Pre-release 说明

## Pre-release Notice

这个项目目前还是一个 pre-release 版本。  
This project is currently still a pre-release version.

平时主要是我自己在用，所以可能会有很多 bug。  
At the moment, I mainly use it myself, so there may still be many bugs.

如果你在使用过程中遇到 bug，欢迎直接反馈给我。  
If you encounter any bugs while using it, please feel free to report them to me.

我会直接修。  
I will fix them directly.

## VibeCodingAssistant-ElonMa 使用说明

## VibeCodingAssistant-ElonMa Usage Instructions

VibeCodingAssistant-ElonMa 是一个面向 Web Coding 的 AI 工作流协调系统。  
VibeCodingAssistant-ElonMa is an AI workflow orchestration system for web coding.

它的核心逻辑不是让单个 AI 直接完成所有事情，而是构建一个可协作、可审查、可留痕的 AI coding team。  
Its core idea is not to let a single AI do everything directly, but to build a collaborative, reviewable, and traceable AI coding team.

当前团队角色包括：  
The current team roles include:

- **Architect**：负责理解原始需求，产出 Plan，并把大任务拆成更细的 execution units / subtasks。  
- **Architect**: Understands the original request, creates the plan, and breaks large tasks into detailed execution units / subtasks.

- **Plan Reviewer**：负责审查 Plan，指出风险、遗漏、边界不清、验证不足等问题。  
- **Plan Reviewer**: Reviews the plan and identifies risks, missing details, unclear boundaries, and insufficient verification.

- **Developer**：只在用户批准 Plan 之后进入执行阶段，按照 Plan 修改代码。  
- **Developer**: Enters the execution phase only after the user approves the plan, then modifies the code according to the plan.

- **Final Reviewer**：在实现完成后独立复查代码变更、测试结果和实现日志，决定是否通过，或打回继续修改。  
- **Final Reviewer**: Independently reviews code changes, test results, and implementation logs after execution, then decides whether to pass the task or send it back for more changes.

- **VibeCodingAssistant-ElonMa**：负责和用户对话、创建任务、推进 workflow、展示 artifacts、记录状态和最终 task record。  
- **VibeCodingAssistant-ElonMa**: Talks with the user, creates tasks, advances the workflow, displays artifacts, records state, and generates the final task record.

这个系统的原则是：**用户的原始 prompt 是最高优先级的 source of truth**。  
The principle of this system is: **the user's original prompt is the highest-priority source of truth**.

系统不会在规划前把用户需求改写成另一个权威需求文档。  
The system does not rewrite the user request into a separate authoritative requirement document before planning.

后续用户通过 `revise`、`restart` 或普通对话追加的约束，会作为新的高优先级上下文进入下一轮 workflow。  
Any later constraints added through `revise`, `restart`, or normal conversation become new high-priority context for the next workflow round.

## 当前推荐 API 组合

## Current Recommended API Combination

我现在实际使用的是 **DeepSeek API + Claude API + Codex API** 的组合。  
My current setup uses a combination of **DeepSeek API + Claude API + Codex API**.

其中，VibeCodingAssistant-ElonMa 这个系统本身的对话和 workflow 调度层使用的是 DeepSeek API。  
The conversation and workflow orchestration layer of VibeCodingAssistant-ElonMa itself uses the DeepSeek API.

当前使用的模型是 `deepseek-v4-flash`。  
The current model is `deepseek-v4-flash`.

选择 DeepSeek v4 Flash 的原因很简单：它非常便宜。  
The reason for choosing DeepSeek v4 Flash is simple: it is very cheap.

它适合承担日常对话、任务路由、状态解释、Lark 消息处理这类高频但不一定需要最贵模型的工作。  
It is suitable for high-frequency work such as daily conversation, task routing, state explanation, and Lark message handling, where the most expensive model is not always necessary.

但 DeepSeek v4 Flash 并不一定最适合复杂 prompt 打磨和需求理解。  
However, DeepSeek v4 Flash is not always the best choice for polishing complex prompts or understanding nuanced requirements.

尤其是比较复杂的 Web Coding 任务，如果原始需求写得不够清楚，DeepSeek 可能无法很好地补全边界、拆解约束或理解真实意图。  
For complex web coding tasks, if the original request is not clear enough, DeepSeek may not fully infer boundaries, decompose constraints, or understand the user's true intent.

所以我现在更推荐的用法是：先用 ChatGPT 把任务 prompt 打磨清楚，再把整理好的 prompt 发给 VibeCodingAssistant-ElonMa 创建任务。  
So my recommended workflow is to first polish the task prompt with ChatGPT, then send the refined prompt to VibeCodingAssistant-ElonMa to create the task.

因为我自己有 ChatGPT Plus，所以用 ChatGPT 来打磨 prompt 基本可以看作是已有会员成本内的使用方式，性价比很高。  
Because I have ChatGPT Plus, using ChatGPT to polish prompts is effectively included in my existing subscription cost, which makes it very cost-effective.

这样 DeepSeek 只负责便宜的日常调度，复杂需求理解交给 ChatGPT，真正的 coding workflow 再交给 Claude 和 Codex。  
In this setup, DeepSeek handles low-cost daily orchestration, ChatGPT handles complex prompt clarification, and the real coding workflow is handled by Claude and Codex.

真正进入 coding workflow 后，Architect、Reviewer、Developer、Final Reviewer 这些重型角色主要使用 Claude 和 Codex。  
Once the task enters the actual coding workflow, the heavier roles such as Architect, Reviewer, Developer, and Final Reviewer mainly use Claude and Codex.

整体思路是：  
The overall idea is:

- **ChatGPT** 负责前期把用户需求打磨成更清楚、更适合执行的 prompt。  
- **ChatGPT** polishes the user's initial request into a clearer and more executable prompt.

- **DeepSeek** 负责 VibeCodingAssistant-ElonMa 的日常对话和 workflow 调度。  
- **DeepSeek** handles daily conversation and workflow orchestration for VibeCodingAssistant-ElonMa.

- **Codex** 更适合执行和落地代码，所以 Developer 阶段默认交给 Codex。  
- **Codex** is better suited for execution and code implementation, so the Developer stage is assigned to Codex by default.

- **Claude** 更适合高层规划、风险判断和最终审查，所以复杂任务里让 Claude 做 Architect 或 Final Reviewer。  
- **Claude** is better suited for high-level planning, risk analysis, and final review, so Claude is used as Architect or Final Reviewer for more complex tasks.

- **Review 阶段尽量让另一个模型审查前一个模型的输出**，避免同一个模型自己规划、自己认可、自己执行。  
- **The Review stage should preferably use a different model to review the previous model's output**, to avoid having the same model plan, approve, and execute its own work.

当前推荐的 Workflow 角色分配如下：  
The currently recommended workflow role assignment is:

| Workflow | Architect | Plan Reviewer | Developer | Final Reviewer |
|---|---|---|---|---|
| **Low** | Codex API | Codex API | Codex API | Codex API |
| **Medium** | Codex API | Claude API | Codex API | Claude API |
| **High** | Claude API | Codex API | Codex API | Claude API |
| **Extra High** | Claude API | Codex API | Codex API | Claude API |

当前我使用得比较顺手的 profile 配置是：  
The profile configuration that currently works well for me is:

- **Prompt 打磨**：ChatGPT Plus。  
- **Prompt polishing**: ChatGPT Plus.

- **VibeCodingAssistant-ElonMa 对话层**：DeepSeek `deepseek-v4-flash`。  
- **VibeCodingAssistant-ElonMa conversation layer**: DeepSeek `deepseek-v4-flash`.

- **Codex coding roles**：`gpt-5.5`，`effort: xhigh`。  
- **Codex coding roles**: `gpt-5.5`, `effort: xhigh`.

- **Claude planning / review roles**：`claude-opus-4-7`，`effort: high`。  
- **Claude planning / review roles**: `claude-opus-4-7`, `effort: high`.

## 四种 Workflow 模式

## Four Workflow Modes

**Low** 适合很小的改动，比如文案、颜色、样式、小 bug、简单组件调整。  
**Low** is suitable for very small changes, such as copy, colors, styling, small bugs, or simple component adjustments.

为了节省成本，Low 模式下 Architect、Plan Reviewer、Developer、Final Reviewer 都使用 Codex。  
To reduce cost, Low mode uses Codex for Architect, Plan Reviewer, Developer, and Final Reviewer.

任务本身风险低时，没有必要每次都拉 Claude 做额外审查。  
When the task itself is low-risk, there is no need to involve Claude for extra review every time.

**Medium** 是默认推荐模式，适合大多数日常 Web Coding。  
**Medium** is the default recommended mode and is suitable for most daily web coding tasks.

它的组合是：Codex 出 Plan，Claude Review，Codex 执行，Claude Final Review。  
Its combination is: Codex creates the plan, Claude reviews it, Codex executes it, and Claude performs the final review.

这个模式在成本和质量之间比较平衡，也是我最推荐别人默认使用的模式。  
This mode provides a good balance between cost and quality, and it is the mode I most recommend as the default.

**High** 适合复杂度更高、影响范围更大、或需要更强规划能力的任务。  
**High** is suitable for tasks with higher complexity, larger impact, or stronger planning requirements.

它的组合是：Claude 做 Architect，Codex 做 Plan Reviewer，Codex 执行，Claude 做 Final Review。  
Its combination is: Claude acts as Architect, Codex acts as Plan Reviewer, Codex executes, and Claude performs the Final Review.

它适合多文件改动、架构调整、复杂状态管理、接口联动、核心功能重构等任务。  
It is suitable for multi-file changes, architecture adjustments, complex state management, API coordination, and core feature refactoring.

**Extra High** 适合高风险、大范围、核心模块级别的任务。  
**Extra High** is suitable for high-risk, large-scope, or core-module-level tasks.

它使用和 High 类似的角色组合，但会在规划阶段加入多轮 Architect ↔ Reviewer 审查。  
It uses a role combination similar to High, but adds multiple Architect ↔ Reviewer review rounds during the planning stage.

系统最多先进行 3 轮规划审查。  
The system runs up to 3 initial planning review rounds.

如果仍然存在 blocking concerns，workflow 会暂停并询问用户是否继续规划、重新规划、停止，或者明确选择带风险执行。  
If blocking concerns still remain, the workflow pauses and asks the user whether to continue planning, restart planning, stop, or explicitly execute with known risks.

## Lark 远程接入

## Remote Access Through Lark

现在的接入端是 **Lark**，也就是飞书的全球版。  
The current access client is **Lark**, the global version of Feishu.

Lark 的优势是免费、轻量，而且手机和电脑都可以下载。  
Lark is free, lightweight, and available on both mobile and desktop.

电脑端可以用 Lark 桌面版，手机端可以下载 Lark App。  
On desktop, you can use the Lark desktop app; on mobile, you can download the Lark app.

登录同一个账号后，所有消息都会自动同步。  
After logging into the same account, all messages are automatically synchronized.

这意味着你可以在电脑前创建和管理 coding task，也可以在手机上远程查看进度、回复难度选择、批准 Plan、要求返工，甚至让系统继续执行任务。  
This means you can create and manage coding tasks from your computer, or remotely check progress, choose difficulty, approve plans, request revisions, and even continue tasks from your phone.

Lark 在这里主要作为远程沟通入口。  
Lark mainly serves as the remote communication entry point here.

真正的 workflow 状态、任务记录、agent 调度和 artifacts 都由本地的 VibeCodingAssistant-ElonMa 维护。  
The actual workflow state, task records, agent orchestration, and artifacts are maintained locally by VibeCodingAssistant-ElonMa.

## 持续运行方式

## Continuous Running Mode

VibeCodingAssistant-ElonMa 本质上是一个运行在你本地电脑上的 assistant service。  
VibeCodingAssistant-ElonMa is essentially an assistant service running on your local computer.

只要你的电脑不关机，并且 VibeCodingAssistant-ElonMa 服务保持运行，它就可以一直通过 Lark 接收消息、创建任务、推进 workflow、调用 Claude / Codex 执行不同阶段的工作，并处理各种 coding task。  
As long as your computer stays on and the VibeCodingAssistant-ElonMa service keeps running, it can continuously receive messages through Lark, create tasks, advance workflows, call Claude / Codex for different stages, and handle coding tasks.

也就是说，它相当于一个常驻在你电脑上的远程 AI coding assistant。  
In other words, it works like a remote AI coding assistant that lives on your computer.

你可以在外面用手机发消息，它会在你的电脑上继续工作。  
You can send messages from your phone while away, and it will continue working on your computer.

你回到电脑前，也可以继续查看同一批任务和 artifacts。  
When you return to your computer, you can continue reviewing the same tasks and artifacts.

## 使用方式

## How To Use It

我现在的实际用法是：**创建任务时，直接使用提前写好的高质量 prompt**。  
My current workflow is: **when creating a task, I directly use a high-quality prompt prepared in advance**.

通常我会先在 ChatGPT 里把需求打磨清楚，再把最终 prompt 发给 VibeCodingAssistant-ElonMa 创建任务。  
Usually, I first polish the requirement in ChatGPT, then send the final prompt to VibeCodingAssistant-ElonMa to create the task.

这样 workflow 一开始拿到的就是比较明确的需求，后面的 Architect、Reviewer 和 Developer 都会更稳定。  
This way, the workflow starts with a clear requirement, making the later Architect, Reviewer, and Developer stages more stable.

用户一般只需要通过 Lark 和 VibeCodingAssistant-ElonMa 对话即可。  
The user usually only needs to talk with VibeCodingAssistant-ElonMa through Lark.

常见流程是：  
The common flow is:

1. 先用 ChatGPT 打磨任务 prompt。  
1. First, polish the task prompt with ChatGPT.

2. 在 Lark 里把整理好的 prompt 发给 VibeCodingAssistant-ElonMa，创建 coding task。  
2. Send the refined prompt to VibeCodingAssistant-ElonMa in Lark to create a coding task.

3. 选择难度：`low`、`medium`、`high` 或 `extra high`。  
3. Choose a difficulty: `low`, `medium`, `high`, or `extra high`.

4. 查看 Plan：可以查看 `revised-plan`、`review`、`assistant-explanation` 等 artifacts。  
4. Review the plan: you can inspect artifacts such as `revised-plan`, `review`, and `assistant-explanation`.

5. 批准或修改当前 Plan。  
5. Approve or revise the current plan.

`approve A` 表示批准当前 Plan，进入执行阶段。  
`approve A` means approving the current plan and entering the execution stage.

`revise C: <修改意见>` 表示要求重新规划。  
`revise C: <revision request>` means requesting a new planning round.

`restart: <新方向>` 表示从新的方向重新开始规划。  
`restart: <new direction>` means restarting planning from a new direction.

`stop` 表示停止当前任务。  
`stop` means stopping the current task.

6. 实现完成后，Final Reviewer 会复查结果。  
6. After implementation is complete, the Final Reviewer reviews the result.

7. 用户确认没问题后，回复 `accept`，系统生成最终 task record。  
7. After the user confirms the result, reply with `accept`, and the system generates the final task record.

所有 workflow 都会留下可查询的 artifacts，包括原始需求、Plan、Review、修订后的 Plan、实现日志、测试日志、Final Review 和最终报告。  
Every workflow leaves queryable artifacts, including the original request, plan, review, revised plan, implementation log, test log, final review, and final report.

这样即使任务很大、上下文被压缩，或者后续需要追溯，也能知道每一步为什么这样做。  
This makes it possible to understand why each step happened, even for large tasks, compressed context, or later audits.

## 安装与配置

## Setup

如果你是第一次配置这个项目，请先阅读 `START_HERE.md`。  
If this is your first time configuring this project, start with `START_HERE.md`.

如果你不熟悉命令行，可以阅读 `START_HERE_FOR_BEGINNERS.md`。  
If you are not familiar with the command line, read `START_HERE_FOR_BEGINNERS.md`.

如果你想让 AI coding agent 帮你配置这个 repo，可以把 `docs/agent-setup-guide.md` 交给它。  
If you want an AI coding agent to help configure this repo, give it `docs/agent-setup-guide.md`.
