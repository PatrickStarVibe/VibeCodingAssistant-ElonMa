**Category:** Docs / Task Record

**Parent Task:** 新增/更新 Manager setup README，让用户能把自己的项目路径、chat bridge credentials、LLM provider、API key env name、角色 profile 配置进去。

**Execution Units:**
1. 审核现有 `README.md` / `START_HERE.md` / example config / env 示例文件，确认 setup 信息当前放在哪里最合适。
2. 更新 `README.md` 或 `START_HERE.md`，补齐 setup 流程：
   - 用户需准备的信息
   - 复制 example config 到 local config
   - 填写 `.env.local`
   - 添加新 project
   - 启动 Lark/飞书 bridge
   - 验证 Elon Ma 能访问用户项目目录
   - 常见错误排查
3. 保持 provider-agnostic：只描述“LLM provider / API key env name / provider command”，不写死或偏向 DeepSeek、OpenAI、Gemini、Claude 任一方。
4. 增加 `Prompt for your coding agent` 小节，列出用户可以发给 Claude/Codex/其他 coding agent 的配置信息清单。
5. 针对已知 review defect，补齐 `START_HERE.md` 中“plan difficulty selection”之后缺失的后续步骤。
6. 验收时忽略 `src/adapters.ts` 和 `tests/adapters.test.ts` 的并行改动，不回退、不拆新任务。

**Acceptance Criteria:**
- 用户下载 repo 后，能按文档完成 local config 和 `.env.local` 配置。
- 文档明确说明如何新增 project、启动 Lark bridge、验证项目目录访问。
- 常见错误包含：API key missing、provider command not found、project path invalid、Lark 权限不对。
- 文档没有把任何单一 LLM provider 写成默认或唯一选择。
- `Prompt for your coding agent` 小节存在且可直接使用。
- `START_HERE.md` 中 plan difficulty selection 后有清晰的下一步操作。

**Verification Commands**
```powershell
git diff -- README.md START_HERE.md
rg -n "Prompt for your coding agent|API key missing|provider command not found|project path invalid|Lark|Feishu|\\.env\\.local|example config|local config|project path|profile" README.md START_HERE.md
rg -n "DeepSeek|OpenAI|Gemini|Claude" README.md START_HERE.md
```
