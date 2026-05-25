**Findings**

1. **Blocking: approval heuristic would reject “no blocking issues”.**  
   The proposed `isReviewerApproval()` says positive phrases include `no blocking issues`, but the negative check rejects any text containing `blocking issue`. Since `no blocking issues` contains that substring, round-1 approval would not stop early and could hit the 3-round cap incorrectly. Add a unit test for exact reviewer text `No blocking issues.` and fix with a regex that does not treat negated “no blocking issue(s)” as a blocker.

2. **Blocking: strict config type means many test configs will fail compile.**  
   `WorkflowRoleProfiles` is a strict `Record<WorkflowDifficulty, ...>` in [types.ts](</C:/Users/24600/OneDrive/文档/Manager/src/types.ts:195>). Once `WorkflowDifficulty` includes `extra-high`, every literal `AssistantConfig.workflowRoles` must include it. The plan only explicitly calls out a few places, but current test configs exist in [workflow.test.ts](</C:/Users/24600/OneDrive/文档/Manager/tests/workflow.test.ts:187>), [adapters.test.ts](</C:/Users/24600/OneDrive/文档/Manager/tests/adapters.test.ts:44>), [bridgeAgent.test.ts](</C:/Users/24600/OneDrive/文档/Manager/tests/bridgeAgent.test.ts:109>), plus several Lark/project tests. `tests/config.test.ts` also needs expectations for default `extra-high` and fallback-from-old-config behavior.

3. **Blocking: conversational prompts still tell agents only low/medium/high exist.**  
   The plan updates parsers and enums, but misses hardcoded LLM instructions in [adapters.ts](</C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:971>) and [adapters.ts](</C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:1013>). Those prompts currently instruct the orchestrator/classifier to use only `low/medium/high`, so “extra high” can still be misrouted before validation. Also update the direct `planTask` message in [workflow.ts](</C:/Users/24600/OneDrive/文档/Manager/src/workflow.ts:97>) and the prompt preview difficulty list in [workflow.ts](</C:/Users/24600/OneDrive/文档/Manager/src/workflow.ts:669>).

4. **High risk: the extra-high helper contract is underspecified for existing metadata flow.**  
   `writePlanMetadata()` requires a `PlanResult`, not just markdown, at [workflow.ts](</C:/Users/24600/OneDrive/文档/Manager/src/workflow.ts:665>). The loop plan should explicitly return the final `PlanResult`, final review markdown, and final revision-instructions markdown. Otherwise an implementation can easily lose `verificationCommands` / `planPackDraft`, double-write `revised-plan`, or make the “fall through unchanged” block impossible.

5. **High risk: per-round log ordering can miss revision instructions.**  
   The plan says append `plan-rounds-log` after the reviewer step, but revision instructions are created after the approval check. To satisfy the requirement to save “plan, review, revision instructions,” the log entry should be appended after revision instructions are known, or updated once they are generated. Add an assertion that round 1 and round 2 log entries include the actual instructions used for the next Planner call.

6. **Missing tests:**  
   Add focused tests for approval detection: `No blocking issues.` approves, `Looks good, but must fix X` does not, and `Approved with blockers` does not. Add config normalization tests proving an old config without `extra-high` gets `extra-high` roles mirrored from `high`. Test conversational routing prompts/tool behavior through the bridge/orchestrator path, not only private parser logic.

**Execution-Unit Review**

The three-unit breakdown is mostly coherent, but Unit 01 is incomplete because it misses several prompt surfaces and all literal config sites. Unit 02 needs a concrete return type/contract before implementation starts. Unit 03 should include config tests and approval-heuristic tests, not just workflow loop scenarios.
