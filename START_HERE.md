# Manager Setup / START HERE

这个文件面向用户自己的 AI coding assistant：下载 Manager repo 后，用它把本地项目、chat bridge 和模型 profile 配好。真实密钥只放在 `.env.local` 或系统环境变量里，不要提交到 git。

如果你不熟悉命令行，先看更慢、更细的 [START_HERE_FOR_BEGINNERS.md](START_HERE_FOR_BEGINNERS.md)。如果你准备把配置工作交给 AI coding agent，请把 [docs/agent-setup-guide.md](docs/agent-setup-guide.md) 一起交给它。项目概览见 [README.md](README.md)。

## 1. 准备信息

开始前先收集这些信息：

- 一个或多个要让 Elon Ma 管理的本地项目路径，例如 `<YOUR_PROJECT_PATH>`。
- Lark / 飞书 app credentials，或你实际使用的 chat bridge credentials。
- 允许使用 bridge 的用户 open ID，以及可选的控制群 chat ID。
- 想使用的 LLM provider 连接方式：API endpoint 或本地命令、模型名、profile 名称。
- 每个 API key 在环境变量中的名字，例如 `<YOUR_API_KEY_ENV>`。
- 各角色使用哪个 profile：`assistant`、`architect`、`planReviewer`、`developer`、`finalReviewer`，以及 `low` / `medium` / `high` / `extra high` 难度对应关系。

## 2. 复制 example config 到 local config

在 Manager repo 根目录执行：

```powershell
Copy-Item .\assistant.config.example.json .\assistant.config.local.json
Copy-Item .\.env.example .\.env.local
```

`assistant.config.example.json` 和 `.env.example` 是 example config；`assistant.config.local.json` 和 `.env.local` 是 local config。把真实路径、profile、credentials env name 和 allowlist 填在本地文件里。

## 3. 填写 `.env.local`

`.env.local` 的变量名必须和 config 里声明的名字一致：

- `profiles.<profile>.apiKeyEnv` 对应 LLM API key。
- `lark.appIdEnv` 对应 Lark / 飞书 app ID。
- `lark.appSecretEnv` 对应 Lark / 飞书 app secret。

示例：

```dotenv
<YOUR_API_KEY_ENV>=<YOUR_API_KEY>
<YOUR_LARK_APP_ID_ENV>=<YOUR_LARK_APP_ID>
<YOUR_LARK_APP_SECRET_ENV>=<YOUR_LARK_APP_SECRET>
```

如果你的 provider 通过本地命令运行，仍然把命令需要的 secret 放到 `.env.local` 或系统环境变量里，然后在 profile 的 `command` 中调用 `<YOUR_PROVIDER_COMMAND>`。

## 4. 配置项目和 profiles

打开 `assistant.config.local.json`，至少检查这些字段：

- `workspace.targetDir`：默认项目路径。通常设成主要项目的 `<YOUR_PROJECT_PATH>`。
- `defaultProjectId`：没有显式指定项目时使用的项目 id。
- `projects[]`：Manager 可访问的项目列表。每个项目应包含 `id`、`name`、`targetDir`、`docsDir`，可选 `taskRecordRoot` 和 `alwaysRead`。
- `projects[].docsDir`：Manager repo 内的项目记忆目录，例如 `project-docs/<PROJECT_ID>`；也可以是绝对路径。
- `projects[].taskRecordRoot`：task record 输出位置。未填写时默认是 `<targetDir>/task`。
- `projects[].alwaysRead`：每次构造项目上下文时都读取的 Markdown 文件，相对于 `docsDir`。
- `lark.allowedOpenIds`：允许与 bridge 对话的用户 open ID。
- `lark.controlChatIds`：可选；限制哪些 chat 可以创建新任务。
- `profiles`：定义 assistant API profile 或命令型 agent profile。
- `workflowRoles`：把 `assistant` 和各难度下的角色映射到 `profiles` 中的 profile 名称。

项目条目示例：

```json
{
  "id": "<PROJECT_ID>",
  "name": "<PROJECT_NAME>",
  "targetDir": "<YOUR_PROJECT_PATH>",
  "docsDir": "project-docs/<PROJECT_ID>",
  "taskRecordRoot": "<YOUR_PROJECT_PATH>/task",
  "alwaysRead": []
}
```

命令型角色 profile 示例：

```json
{
  "kind": "command",
  "provider": "<YOUR_PROVIDER_NAME>",
  "command": "<YOUR_PROVIDER_COMMAND>"
}
```

API 型 assistant profile 需要填写 `model`、`baseUrl` 和 `apiKeyEnv`；`apiKeyEnv` 的值必须是 `.env.local` 中的变量名，例如 `<YOUR_API_KEY_ENV>`。

## 5. 添加新 project

有两种方式：

1. 直接把项目条目加入 `assistant.config.local.json` 的 `projects[]`。
2. 或把项目条目加入 `assistant.projects.local.json`：

```json
{
  "projects": [
    {
      "id": "<PROJECT_ID>",
      "name": "<PROJECT_NAME>",
      "targetDir": "<YOUR_PROJECT_PATH>",
      "docsDir": "project-docs/<PROJECT_ID>",
      "alwaysRead": []
    }
  ]
}
```

然后确认 Manager 能加载项目：

```powershell
npm run assistant -- projects --config assistant.config.local.json
```

如果输出里出现 `<PROJECT_ID>` 和 `<YOUR_PROJECT_PATH>`，项目注册成功。

## 6. 启动 Lark bridge

确保 `.env.local` 已包含 app credentials 和 assistant API key 后运行：

```powershell
npm run assistant:lark -- --config assistant.config.local.json
```

如果只想验证 bridge、权限和项目路由，先避免调用重型 agent：

```powershell
npm run assistant:lark -- --config assistant.config.local.json --stub-heavy-agents
```

bridge 启动后，只会处理 `lark.allowedOpenIds` 中用户发来的消息。`controlChatIds` 只限制哪些 chat 可以创建新任务，不会替代 open ID 授权。

## 7. 确认 Elon Ma 能访问项目目录

先列出项目：

```powershell
npm run assistant -- projects --config assistant.config.local.json
```

再创建一个小测试任务：

```powershell
npm run assistant -- create --config assistant.config.local.json --project <PROJECT_ID> --title "setup-smoke-test" --task "Check whether this Manager setup can read the configured project root and project docs."
```

命令会返回 task id。先进入规划流程：

```powershell
npm run assistant -- plan --config assistant.config.local.json --task <TASK_ID>
```

此时可以先预览 agent 将收到的项目上下文，确认 `Target workspace` 指向 `<YOUR_PROJECT_PATH>`：

```powershell
npm run assistant -- show --config assistant.config.local.json --task <TASK_ID> --artifact agent-prompt-preview
```

### Plan difficulty selection 之后

第一次 `plan` 会停在难度选择。选择 `low`、`medium`、`high` 或 `extra high` 后，workflow 才会真正生成计划：

```powershell
npm run assistant -- reply --config assistant.config.local.json --task <TASK_ID> "low"
```

计划生成后检查状态和关键 artifacts：

```powershell
npm run assistant -- status --config assistant.config.local.json --task <TASK_ID>
npm run assistant -- show --config assistant.config.local.json --task <TASK_ID> --artifact revised-plan
npm run assistant -- show --config assistant.config.local.json --task <TASK_ID> --artifact assistant-explanation
```

如果只是验证 heavy-agent 路由但不想真的调用命令型 profile，CLI 默认会使用 stub heavy agents。确认要调用各角色的真实命令型 profile 时，再给 `plan` / `reply` 命令加 `--allow-agent-calls`。

如果计划正确，批准实现：

```powershell
npm run assistant -- reply --config assistant.config.local.json --task <TASK_ID> "approve A"
```

如果计划需要改，要求重新规划：

```powershell
npm run assistant -- reply --config assistant.config.local.json --task <TASK_ID> "revise C: <WHAT_TO_CHANGE>"
```

实现和 final review 结束后，任务会进入 `awaiting_user_acceptance`。先查看最终状态和 review，再验收并生成 task record：

```powershell
npm run assistant -- status --config assistant.config.local.json --task <TASK_ID>
npm run assistant -- show --config assistant.config.local.json --task <TASK_ID> --artifact final-review
npm run assistant -- reply --config assistant.config.local.json --task <TASK_ID> "accept"
```

如果 final review 把任务路由回实现阶段，按提示回复 `approve A` 继续返工，或回复 `stop` 暂停。若它要求产品/范围决定，直接回复你的决定，或用 `revise C: <WHAT_TO_CHANGE>` 重新规划。

如果 `projects` 命令能显示正确路径，`agent-prompt-preview` 的 `Target workspace` 指向 `<YOUR_PROJECT_PATH>`，并且后续 artifacts 能正常生成，Elon Ma 已经能定位并使用用户自己的项目目录。

## 8. 常见错误

- API key missing：检查 `.env.local` 是否存在；变量名是否和 `profiles.<profile>.apiKeyEnv` 完全一致；如果系统环境变量已有同名空值，先修正系统环境变量。
- provider command not found：检查命令型 profile 的 `command`；确认 `<YOUR_PROVIDER_COMMAND>` 在当前 shell 的 `PATH` 中，或改成绝对路径。
- project path invalid：检查 `workspace.targetDir` 和 `projects[].targetDir` 是否是本机真实目录；Windows 路径可以使用 `/` 或转义后的 `\\`。
- Lark 权限不对：检查 app credentials、bot 是否启用、事件订阅是否打开、收发消息和建群/上传文件权限是否已授权；确认发消息用户的 open ID 在 `allowedOpenIds` 中，目标 chat 在 `controlChatIds` 中或未启用该限制。

## 9. Prompt for your coding agent

把下面内容发给你的 coding agent，让它替你完成本地配置：

```text
Please configure this Manager repo for my local AI coding workflow.

Repo path:
<MANAGER_REPO_PATH>

Projects to add:
- id: <PROJECT_ID>
  name: <PROJECT_NAME>
  targetDir: <YOUR_PROJECT_PATH>
  docsDir: project-docs/<PROJECT_ID>
  taskRecordRoot: <OPTIONAL_TASK_RECORD_ROOT>
  alwaysRead: <OPTIONAL_MARKDOWN_FILES>

Provider/profile setup:
- assistant profile: <ASSISTANT_PROFILE_NAME>
- low roles: architect=<PROFILE>, planReviewer=<PROFILE>, developer=<PROFILE>, finalReviewer=<PROFILE>
- medium roles: architect=<PROFILE>, planReviewer=<PROFILE>, developer=<PROFILE>, finalReviewer=<PROFILE>
- high roles: architect=<PROFILE>, planReviewer=<PROFILE>, developer=<PROFILE>, finalReviewer=<PROFILE>
- extra-high roles: architect=<PROFILE>, planReviewer=<PROFILE>, developer=<PROFILE>, finalReviewer=<PROFILE>
- API key env names: <YOUR_API_KEY_ENV>, <OTHER_KEY_ENV_IF_ANY>
- provider command, if command-backed: <YOUR_PROVIDER_COMMAND>
- model names, if API-backed: <YOUR_MODEL_NAME>

Chat bridge setup:
- app id env name: <YOUR_LARK_APP_ID_ENV>
- app secret env name: <YOUR_LARK_APP_SECRET_ENV>
- allowed open IDs: <OPEN_ID_LIST>
- control chat IDs, if any: <CHAT_ID_LIST>

You may edit only local setup files such as assistant.config.local.json, assistant.projects.local.json, and .env.local. Do not commit real secrets. After editing, run:
- npm run assistant -- projects --config assistant.config.local.json
- npm run build
- npm test
```
