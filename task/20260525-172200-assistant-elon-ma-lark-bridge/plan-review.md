结论：计划方向正确，但不建议按这个版本直接实施。需要先修订下面几个阻塞点。

**Findings**
1. **阻塞：执行层校验仍不完整，tool gate 不能当最终防线。**  
   计划只给 `waiting_user_direction` 的 stale `approve_plan` 加兜底，但 [src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:237) 的 `approve_plan`、[src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:233) 的 `choose_difficulty`、[src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:260) 的 `revise_plan` 仍会先返回 background started message，再让异步 workflow 去失败或误推进。尤其 `approve_plan` 如果在 `awaiting_user_acceptance` 被异常调用，workflow 里 `approve` 会走验收完成路径 [src/workflow.ts](C:/Users/24600/OneDrive/文档/Manager/src/workflow.ts:393)。计划必须加入集中式 `assertToolAllowedForState`，在 `workflowBackground` 前拦截所有非法阶段 tool call，并返回“没有推进 workflow + 当前可用操作”。

2. **阻塞：拟定工具集和 workflow 实际状态机不一致。**  
   计划把 `READY_FOR_DECISION_TOOL_NAMES` 同时用于 `ready_for_decision / implementation_approved`，且包含 `revise_plan`。但 workflow 只允许 `revise` 在 `ready_for_decision`、`waiting_user_direction` 或 `awaiting_user_acceptance`，不允许 `implementation_approved` [src/workflow.ts](C:/Users/24600/OneDrive/文档/Manager/src/workflow.ts:399)。应拆成 `READY_FOR_DECISION` 和 `IMPLEMENTATION_APPROVED` 两套。  
   另外计划前文说 `awaiting_user_acceptance` “only accept_task”，后面工具集又包含 `revise_plan`。如果保留“验收后要求返工”，需要明确这是合法产品行为，并修复当前 `revise_plan` 被包装成 `replanning` background 的误导性 started message。

3. **阻塞：重写 `bridgeToolNamesForInput` 时可能丢掉 bound task 安全兜底。**  
   当前代码即使 `input.task` 没加载到，也会因为 `input.chat.boundTaskId` 暴露 active-task 工具 [src/adapters.ts](C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:600)。计划写成“先按 `input.task?.status`，再 fallback idle/control”，容易让有 bound task 但 state 读取失败的 Project Chat 被当 idle，暴露 `create_task`。应增加测试：`project chat + boundTaskId + task undefined` 不得暴露 `create_task` 或推进类工具，只能暴露保守查询/停止类工具。

4. **缺少用户明确要求的“无可用 tool”测试和确定性路径。**  
   计划主要靠 prompt 让模型说“没有 tool”，但适配器现在会直接忽略不可用 tool name [src/adapters.ts](C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:364)，JSON content 里的不可用 tool 也会退化成普通 reply [src/adapters.ts](C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:379)。这不能保证“说明缺少对应 tool，并列出当前可用动作”。需要补一个 deterministic fallback/helper，并加测试覆盖“用户请求当前阶段没有的动作”。

5. **fake-claim guard 测试不够。**  
   计划只测 `reply_to_user` 假称“我会推进 workflow”，但 `handleMessage` 对 `decision.kind === 'reply'` 也会直接透传 [src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:122)。需要同时测 direct reply 和 `reply_to_user` tool。另，“keep rejected text in audit trail”目前 `auditAction` 只是 string；如果真要保留原文，需要新增审计字段或明确只记录 `guard:fake-claim`。

6. **产品一致性风险：`show_status` 对 `waiting_user_direction` 的下一步提示仍可能说 approve/revise。**  
   `bridgeNextStep` 把 `ready_for_decision` 和 `waiting_user_direction` 合并提示 [src/bridgeAgent.ts](C:/Users/24600/OneDrive/文档/Manager/src/bridgeAgent.ts:689)。这会和新契约冲突：该阶段应提示回答 `pendingUserPrompt`，而不是 approve/revise。计划应补这个修正和测试。

**Execution Unit**
单个 execution unit 在文件范围上是连贯的，但内容太容易漏掉执行层最终校验。建议仍可作为一个 unit，但必须把“状态到工具表”和“执行层状态校验/非法动作 fallback”作为同等一等目标，而不是只做曝光表和 prompt。否则会修掉 LLM 常规路径，却留下异常 tool call 误推进的核心风险。
