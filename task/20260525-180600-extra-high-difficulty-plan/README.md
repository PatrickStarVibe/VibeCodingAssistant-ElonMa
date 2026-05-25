# 新增 extra high difficulty 档位及多轮 Plan 打磨机制

## Task Info

| Field | Value |
|---|---|
| Task ID | 20260525-180600-extra-high-difficulty-plan |
| Title | 新增 extra high difficulty 档位及多轮 Plan 打磨机制 |
| Category | Assistant / Workflow |
| Status | completed |
| Execution Mode | decomposed |

## Original Request

# 新增 extra high difficulty 档位及多轮 Plan 打磨机制

请在现有 workflow 里新增一个 difficulty 档位：extra high。 extra high 的目标是在现有 high 流程基础上，增加 Planner 和 Reviewer 的多轮 plan 打磨机制，尽可能产出"Reviewer 找不出问题"的高质量 plan。 具体规则： 1. extra high 仍然沿用 high 的角色配置基础： - Planner / Architect 使用 high 档位对应的规划角色。 - Reviewer 使用 high 档位对应的 review 角色。 - Developer 和 FinalReviewer 暂时沿用 high 档位配置。 2. extra high 的 planning 阶段需要支持最多 3 轮 Planner ↔ Reviewer 来回。 3. 一轮的定义是： - Planner 生成或修改 plan，并提交给 Reviewer。 - Reviewer review 这个 plan，并指出问题。 - Planner 收到 Reviewer 的反馈。 这算作一轮。 4. 第一轮由 Planner 根据原始用户需求生成 plan，然后 Reviewer review。 如果 Reviewer 明确表示没有 blocking issues、no issues、approved、looks good 或等价含义，则 planning 阶段结束，进入后续 workflow。 如果 Reviewer 找到问题，则 Planner 必须根据 Reviewer 的反馈修改 plan，并进入下一轮。 5. 第二轮和第三轮重复： - Planner 基于上一版 plan + Reviewer 反馈生成新版 plan。 - Reviewer 再次 review。 - 如果 Reviewer 不再指出问题，则结束循环。 - 如果达到第 3 轮后 Reviewer 仍然指出问题，则停止继续打磨，使用第 3 轮 Planner 产出的最新版 plan，并把 Reviewer 的剩余问题记录进 artifact / decision log，供后续实现和 final review 参考。 6. extra high 不要求无限追求完美，暂定最多3 轮，避免 workflow 卡死或成本失控。 7. 需要把每一轮的 plan、review、revision instructions 或等价信息保存到 artifact / log 中，方便之后查看为什么 plan 是这样演化的。 8. 需要更新类型、配置、CLI/对话里的 difficulty 解析、提示文案、测试用例和文档，使 low / medium / high / extra high 都能正常工作。 验收标准： - 用户可以选择 extra high difficulty。 - extra high 会触发最多 3 轮 Planner ↔ Reviewer planning loop。 - Reviewer 认可后会提前结束循环。 - 达到 3 轮上限后不会继续卡住。 - 现有 low / medium / high 行为不回归。 - build 和 tests 通过。

## Plan Summary

Category: Assistant / Workflow

## Queue Summary

All execution units are done.

## Subtask Status

| Subtask | Status |
|---|---|
| [01 - Type, config, parser, and prompt foundation](subtasks/01-type-config-parser-and-prompt-foundation.md) | Done |
| [02 - Multi-round Planner ↔ Reviewer loop in `WorkflowService.planTask`](subtasks/02-multi-round-planner-reviewer-loop-in-wor.md) | Done |
| [03 - Tests, prompt-routing tests, and documentation](subtasks/03-tests-prompt-routing-tests-and-documenta.md) | Done |

## Token Usage

Ledger: [token-usage.json](token-usage.json)

No token usage entries recorded yet. Usage is unknown, not zero.

Query usage from this workflow repo: `npm run assistant -- usage --task 20260525-180600-extra-high-difficulty-plan --by role`

## Test Summary

See `test-build-log.md` and subtask Test Result sections.

## Final Review Status

Final review recorded.

## User Acceptance Status

Accepted at 2026-05-25T18:56:24.527Z.

## Final Completion Status

Completed.
