# Revised Plan — Provider-agnostic 配置层整理

| Field | Value |
|---|---|
| Task ID | 20260525-042725-provider-agnostic |
| Category | Assistant / Workflow |
| Execution Mode | decomposed (3 sequential execution units) |
| Workflow difficulty | high |
| Revision | 2 (incorporates reviewer feedback) |

## Goal

让 Manager 的配置层不再写死任何具体 provider（DeepSeek / Codex / Claude）。用户通过 `assistant.config.local.json` + `.env.local` / 环境变量自由组合 OpenAI / DeepSeek / Gemini / Claude / 其他 OpenAI 兼容 provider；缺少 key/command 时给出可定位的错误（含 profile 名 + role 名 + 字段名 + 修改位置）；repo 不包含任何真实 secret 或 provider 假设；workflow 逻辑与 SDK 依赖完全不动。

## 调研事实（决策依据）

- `src/config.ts:241` `loadConfig` 用 example 兜底，被 local 覆盖；本仓库 `assistant.config.local.json` 已存在 → `loadConfig(repoRoot)` **不能**用来证明 example 可加载。
- `src/types.ts` `AgentProfileKind = 'deepseek' | 'codex' | 'claude' | 'stub'`（封闭 union）。`AgentProfileConfig` 已含 `kind / model / effort / baseUrl / apiKeyEnv / command`。
- `src/adapters.ts:681` `DeepSeekAssistantAdapter` 构造签名只有 `(profile, env)`，没有 profile 名 / role 上下文。
- `src/adapters.ts:689,704,723,737` 把 `apiKeyEnv ?? 'DEEPSEEK_API_KEY'`、`baseUrl ?? 'https://api.deepseek.com/v1'`、`model ?? 'deepseek-v4-flash'` 作为 fallback。
- `src/adapters.ts:1210,1240` `CliHeavyAgentAdapter` 把 `profile.command ?? 'codex' | 'claude'` 作为 fallback。
- `src/processRunner.ts:11` `runFile` **不会抛**，ENOENT 转成 `{ code: 1, stderr }`；adapter 必须显式检查 `result.code !== 0` 或前置校验，不能依赖 try/catch。
- `src/cli.ts:124` `makeWorkflow` 直接调 `loadConfig`，未加载任何 dotenv 文件 → `.env.local` 当前不会被自动读入 `process.env`。
- `assistant.config.example.json` 当前写满 DeepSeek / `codex` / `claude` 真实 provider 字段。
- `tests/config.test.ts` 当前硬测具体 profile 名/model，需重写。
- `.gitignore` 缺 `.env*` 条目。

## 设计决策

### 1. Profile schema（不新增 SDK，不改 workflow）

新增 kind：`'openai-compatible'`（assistant adapter 主路径，处理任何 OpenAI `/chat/completions` + Bearer token 形态的 provider）。保留 `'deepseek' | 'codex' | 'claude' | 'stub'`，其中 `'deepseek'` 视作 `'openai-compatible'` 的**别名**（向后兼容现有 local config）。

字段契约：

| 字段 | openai-compatible / deepseek | codex / claude | stub |
|---|---|---|---|
| `kind` | required | required | required |
| `model` | required | optional | n/a |
| `apiKeyEnv` | required | n/a | n/a |
| `baseUrl` | **optional**（kind=`openai-compatible` 时缺省走 `https://api.openai.com/v1`；kind=`deepseek` 别名仍要求显式 baseUrl，避免误导）| n/a | n/a |
| `command` | n/a | required | n/a |
| `effort` | n/a | optional | n/a |

`baseUrl` 的 optional 策略写进文档（`assistant.config.example.json` 内联注释字段 + README 段落）。

### 2. Profile 校验集中：`validateProfileForRole`

新建 `src/profileValidation.ts` 导出 `validateProfileForRole({ profileName, role, profile, env })`。校验时机：

- **静态校验**（profile 字段完整性）：在 `createAssistantAdapter` / `createHeavyAgentAdapter` 解析到具体 profile 时立即调用，缺字段直接抛 —— **不留到 `runFile` 时**。
- **运行时校验**（env 中实际有 key）：仍在 adapter 第一次发起 LLM 调用时检查 `env[apiKeyEnv]`。

错误模板（统一）：

```
Profile "<profileName>" (role: <role>, kind: <kind>) is missing required field <field>.
Set profiles.<profileName>.<field> in assistant.config.local.json
[ or set env var <apiKeyEnv> in .env.local ].
```

### 3. Adapter 构造签名变更（传入 profile / role 上下文）

- `DeepSeekAssistantAdapter` → 改名 `OpenAICompatibleAssistantAdapter`，构造签名扩为 `(profile, env, ctx: { profileName: string; role: string })`。保留 `export const DeepSeekAssistantAdapter = OpenAICompatibleAssistantAdapter`（向后兼容外部 import）。
- `CliHeavyAgentAdapter` 内部 `codex(...)` / `claude(...)` 已经接收 `profileName` + `role`，不需要构造改造，但需要：
  - 在 `runFile` 调用前若 `profile.command` 为 undefined → 直接抛带模板的错误。
  - 在 `runFile` 调用后若 `result.code !== 0` 且 `result.stderr` 含 `ENOENT` → 包装为带模板的错误（"command `<x>` not found in PATH for profile ..."）。检查 stderr 子串而非依赖异常。
- `createAssistantAdapter(config)` 现已能拿到 `assistant.profile` 名（即 `config.assistant.profile`）和 role 字符串 `'assistant'`，传给构造器。
- 直接构造 adapter 的测试需要补 `ctx`（提供 dummy `{ profileName: 'test', role: 'assistant' }`）。

### 4. `defaultConfig()` 处理

`defaultConfig()` 退化成"系统底裤"：保留结构，但所有 profile 改为 `kind: 'stub'`，无任何真实 provider 字符串。真实 provider 必须从 example/local 加载。

### 5. `.env.local` 自动加载

在 `loadConfig` 顶部加入轻量 dotenv 加载（不引入新依赖；手写一个最小 parser，约 30 行，仅支持 `KEY=value` / `KEY="value"` / `#` 注释）：

- 读取顺序：`.env.local` → `.env`（local 优先；已存在的 `process.env` 永不覆盖）。
- 文件不存在静默跳过。
- 在 `loadConfig` 入口、`assistant.config.example.json` 读取之前调用，让 CLI 与测试共享同一行为。
- 测试中通过传 `env` override 或 cwd override 控制读取目标。

### 6. 示例配置 (provider-neutral)

`assistant.config.example.json` 完全去 Codex/Claude 假设：

```json
{
  "workspace": { "targetDir": "<your-target-dir>" },
  "assistant": { "profile": "profile-assistant" },
  "profiles": {
    "profile-assistant": {
      "kind": "openai-compatible",
      "model": "<your-llm-model>",
      "baseUrl": "<https://your-llm-provider.example.com/v1>",
      "apiKeyEnv": "LLM_API_KEY"
    },
    "profile-architect": {
      "kind": "codex",
      "command": "<your-cli-command>",
      "model": "<your-architect-model>",
      "effort": "<your-effort>"
    },
    "profile-planner": {
      "kind": "codex",
      "command": "<your-cli-command>",
      "model": "<your-planner-model>",
      "effort": "<your-effort>"
    },
    "profile-developer": {
      "kind": "codex",
      "command": "<your-cli-command>",
      "model": "<your-developer-model>",
      "effort": "<your-effort>"
    },
    "profile-reviewer": {
      "kind": "codex",
      "command": "<your-cli-command>",
      "model": "<your-reviewer-model>",
      "effort": "<your-effort>"
    },
    "profile-final-reviewer": {
      "kind": "claude",
      "command": "<your-cli-command>",
      "model": "<your-final-reviewer-model>",
      "effort": "<your-effort>"
    }
  },
  "workflowRoles": {
    "low":    { "architect": "profile-architect", "planReviewer": "profile-reviewer", "developer": "profile-developer", "finalReviewer": "profile-final-reviewer" },
    "medium": { "architect": "profile-architect", "planReviewer": "profile-reviewer", "developer": "profile-developer", "finalReviewer": "profile-final-reviewer" },
    "high":   { "architect": "profile-architect", "planReviewer": "profile-reviewer", "developer": "profile-developer", "finalReviewer": "profile-final-reviewer" }
  },
  "lark": {
    "appIdEnv": "LARK_APP_ID",
    "appSecretEnv": "LARK_APP_SECRET",
    "allowedOpenIds": ["ou_your_open_id_here"]
  },
  "verification": { "allowlist": [] }
}
```

无 `codex-*` / `claude-*` 名称。`command` 一律 `<your-cli-command>` placeholder，刻意不可运行 —— 强制用户拷贝到 local 后填值。文档（README 顶部小段）给出三个具体示例：OpenAI、DeepSeek、Gemini OpenAI-compat。

### 7. `.env.example` + `.gitignore`

`.env.example`（新建）：

```
# Copy to .env.local and fill in real values. .env.local is git-ignored.
# Auto-loaded by loadConfig() at startup; values already in the shell take precedence.

# LLM API key — name must match profiles.<profile>.apiKeyEnv in assistant.config.local.json
LLM_API_KEY=

# Lark bot credentials (optional; only needed when using Lark integration)
LARK_APP_ID=
LARK_APP_SECRET=

# Add additional provider keys as needed and reference them via apiKeyEnv:
# OPENAI_API_KEY=
# DEEPSEEK_API_KEY=
# GEMINI_API_KEY=
# ANTHROPIC_API_KEY=
```

`.gitignore` 追加：

```
# local secrets and runtime env
.env
.env.local
.env.*.local
!.env.example
```

## Out of Scope

- 不改 workflow 状态机 / orchestrator / bridge agent 行为。
- 不动 Lark 集成实现。
- 不新增 npm 依赖（dotenv 自实现 ~30 行；不引入 `dotenv` package）。
- 不实现真实 `claude-api` kind（不引入 Anthropic SDK）。
- 不动用户私有 `assistant.config.local.json`。

## Execution Units (Sequential)

执行顺序为 **02 → 01 → 03**：先把 example 形态钉住，再按新形态调整 schema/校验/adapter，最后写测试。

### Task 02 (执行第 1 步): Provider-neutral 示例配置 + `.env.example` + `.gitignore`

**触及文件**

- `assistant.config.example.json`：整文件按上面 §6 重写。所有 profile 名 `profile-*`，所有 `command` 为 `<your-cli-command>`，所有 model/baseUrl/effort 为占位符，`apiKeyEnv` 用 `LLM_API_KEY`。
- 新建 `.env.example`：内容如 §7。
- `.gitignore`：追加 §7 中的四行 + 注释；保留现有所有 ignore 规则。
- `START_HERE.md` 顶部新增 ≤15 行的"配置 provider"小节：指向 `cp .env.example .env.local`、`cp assistant.config.example.json assistant.config.local.json`，并给出 OpenAI / DeepSeek / Gemini OpenAI-compat 三个 `profile-assistant` 片段示例。

**验收**

- `git grep -i "deepseek\|api.openai\|googleapis\|anthropic\|codex\|claude" assistant.config.example.json` 输出为空（不再含任何具体 provider/CLI 字符串）。
- `.env.example` 中所有等号右侧为空。
- `.gitignore` 包含 `.env`、`.env.local`、`.env.*.local`、`!.env.example`。

### Task 01 (执行第 2 步): Schema + dotenv loader + 校验 + adapter 解耦

**触及文件**

- `src/types.ts`：`AgentProfileKind` 加 `'openai-compatible'`，保留旧 union 成员。
- 新建 `src/dotenv.ts`：~30 行手写 parser，导出 `loadDotenvFiles(cwd: string, env: NodeJS.ProcessEnv = process.env): void`。语义：依次尝试 `cwd/.env.local`、`cwd/.env`；逐行解析 `KEY=value` / `KEY="value"` / `KEY='value'` / `# comment` / 空行；**已存在于 `env` 的 key 永不覆盖**；文件不存在静默跳过；解析错误（例如缺等号）忽略该行不抛。
- `src/config.ts`：在 `loadConfig` 入口（读 example 之前）调用 `loadDotenvFiles(assistantRoot)`。`defaultConfig()` 改为返回最小 stub 结构（无真实 provider 字符串）。
- 新建 `src/profileValidation.ts`：导出 `validateProfileForRole(args: { profileName: string; role: string; profile: AgentProfileConfig | undefined; env?: NodeJS.ProcessEnv })`。校验逻辑：
  - profile 不存在 → 抛 `Profile "<profileName>" (role: <role>) is not defined in profiles map. Add it to assistant.config.local.json.`
  - LLM-API kind（`openai-compatible` / `deepseek`）：必须有 `apiKeyEnv` 与 `model`；`baseUrl` 仅在 `kind === 'deepseek'` 时强制（避免别名误导）；`kind === 'openai-compatible'` 缺 `baseUrl` 时通过（adapter 内 fallback 到 `https://api.openai.com/v1`）。**不在静态阶段检查 `env[apiKeyEnv]` 是否有值**；运行时由 adapter 检查。
  - CLI kind（`codex` / `claude`）：必须有 `command`。
  - `stub`：无要求。
  - 错误统一用 §2 模板。
- `src/adapters.ts`：
  - `DeepSeekAssistantAdapter` → 改名 `OpenAICompatibleAssistantAdapter`，构造 `(profile, env, ctx: { profileName, role })`；删除 `apiKeyEnv ?? 'DEEPSEEK_API_KEY'` / `baseUrl ?? 'https://api.deepseek.com/v1'` / `model ?? 'deepseek-v4-flash'` 三个 fallback；`baseUrl` 缺省走 `https://api.openai.com/v1`（仅 `kind=openai-compatible`，`kind=deepseek` 已被 validation 拦下）；缺 key/model 时抛模板错误（含 `ctx.profileName` + `ctx.role`）。`export const DeepSeekAssistantAdapter = OpenAICompatibleAssistantAdapter` 保兼容。
  - `createAssistantAdapter(config)`：先调用 `validateProfileForRole({ profileName: config.assistant.profile, role: 'assistant', profile, env: process.env })`；接受任何 LLM-API kind（`openai-compatible` / `deepseek`），其他 kind 抛包含 expected kinds 的错误；构造时传 `ctx`。
  - `CliHeavyAgentAdapter.codex(...)` / `.claude(...)`：删除 `?? 'codex'` / `?? 'claude'` fallback；进入函数即调 `validateProfileForRole({ profileName, role, profile, env: process.env })`，缺 `command` 立即抛。`runFile` 返回后若 `result.code !== 0` 且 stderr 包含 `ENOENT`（不区分大小写）→ 包装为：`Profile "<profileName>" (role: <role>, kind: <kind>) command "<command>" was not found in PATH. Install the CLI or update profiles.<profileName>.command in assistant.config.local.json.`
  - `createHeavyAgentAdapter(config, allowAgentCalls)`：保持现签名；不需要预校验所有 profile（lazy 校验在每次 role 调用时进行，避免 example/stub 模式下启动即崩）。

**验收**

- `git grep -nE "'DEEPSEEK_API_KEY'|'deepseek-v4-flash'|'api.deepseek.com'|\?\? 'codex'|\?\? 'claude'" src/` 输出为空。
- `npx tsc --noEmit` 不报错。
- 手动启动 stub workflow（无 key、无 CLI）不应在 `loadConfig` 阶段崩溃，仅在 role 真正被调用时报清晰错误。

### Task 03 (执行第 3 步): 测试

**触及文件**

- `tests/config.test.ts`：删除"硬测 codex-architect.model === gpt-5.5"等 case。新增：
  - `loadConfig` 在**临时目录**（仅含拷贝过来的 `assistant.config.example.json`，无 local）能成功加载，返回的 `profiles` 含 `profile-assistant`、`workflowRoles.high.architect` 指向 profiles 中 existing key。实现方式：`mkdtempSync` → 拷贝 example 文件 → `loadConfig(tempDir)` → 断言。**不**用 `loadConfig(repoRoot)`，因为本仓库的 local config 会盖掉 example。
  - "example 不含具体 provider"：读 `assistant.config.example.json` 文本，断言不出现下列子串（不区分大小写）：`deepseek`、`api.openai`、`googleapis`、`anthropic`、`gpt-`、`codex-`、`claude-`、`sk-`。
  - "dotenv loader 不覆盖已有 env"：构造 tempDir 含 `.env.local` 写入 `LLM_API_KEY=fromfile`，先设 `process.env.LLM_API_KEY = 'fromshell'`，调 `loadDotenvFiles(tempDir)`，断言 `process.env.LLM_API_KEY === 'fromshell'`。case 结束清理 env。
  - "dotenv loader 在 env 缺失时填入文件值"：tempDir `.env.local` 写 `MY_TEST_VAR=xyz`，`delete process.env.MY_TEST_VAR`，调 `loadDotenvFiles`，断言为 `xyz`。
- `tests/adapters.test.ts`：
  - 把现有依赖 `DeepSeekAssistantAdapter` 直接构造的 case 改为传 `ctx: { profileName: 'test', role: 'assistant' }`，并用 `OpenAICompatibleAssistantAdapter` 名字（保留 1 个用别名构造的 case 验证向后兼容）。
  - 新 case "assistant adapter 接受 openai-compatible kind"：`profile.kind = 'openai-compatible'` + `apiKeyEnv: 'LLM_API_KEY'` + `model: 'm'` + `baseUrl: 'http://x/v1'` + env `LLM_API_KEY=sk-test`，`createAssistantAdapter(config)` 不抛。
  - 新 case "assistant adapter 接受 openai-compatible kind 不带 baseUrl（默认 OpenAI）"：同上但删 `baseUrl`，不抛。
  - 新 case "缺 apiKeyEnv 字段时静态校验报含 profile/role 名错误"：profile 无 `apiKeyEnv`，`createAssistantAdapter` 抛包含 profile 名 + role 名 + `apiKeyEnv` + `assistant.config.local.json` 的错误。
  - 新 case "env 中无 key 时运行时报含 env var 名错误"：profile `apiKeyEnv: 'MY_TEST_KEY'`，env 删该 key，调 `chat`/`classifyIntent`（mock fetch 不被调用），断言 error 含 `MY_TEST_KEY` + profile 名 + role 名 + `.env.local`。
  - 新 case "缺 command 的 codex profile 静态校验报错"：构造 `kind: 'codex'` 无 `command` 的 profile，通过 `createHeavyAgentAdapter` 取 adapter，调 `createInitialPlan` → 断言 error 含 profile 名 + `command` + `assistant.config.local.json`。
  - 新 case "ENOENT 包装"：mock `runFile` 返回 `{ code: 1, stdout: '', stderr: 'spawn xxx ENOENT' }`，断言 adapter 抛包含 `not found in PATH` + profile 名 + command 字符串的错误。

**验收**

- `npm test` 全绿。
- `npx tsc --noEmit` 不报错。

## 风险 & 取舍

- **向后兼容**：用户现有 `assistant.config.local.json` 多用 `kind: 'deepseek'`。删除 fallback 后，缺 `baseUrl`/`model`/`apiKeyEnv` 的旧 config 会立刻报错。**缓解**：错误消息精确指向缺失字段 + 修改路径；PR 描述 / `START_HERE.md` 显式标注此 breaking change 与迁移步骤。`'deepseek'` kind 仍工作（视作 `'openai-compatible'` 别名）。
- **CLI 命令存在性**：跨平台 `which/where` 检测不写；改为 stderr 子串匹配 `ENOENT`，cover Windows + POSIX execFile 行为。
- **手写 dotenv parser**：刻意保持极简（无 `export`、无变量插值、无多行）。如未来需求增长再换 `dotenv` 包；当前不引入依赖。
- **example 不可直接运行**：所有 `command` 为 `<your-cli-command>`、所有 model/baseUrl 为占位符。这是刻意设计 —— 任何"开箱跑"都需用户先 cp 到 local 并填值，避免暗示某个 provider。

## Verification Commands

- npm test
- npx tsc --noEmit
