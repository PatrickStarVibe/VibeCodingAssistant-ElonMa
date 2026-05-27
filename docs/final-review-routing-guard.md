# Final Review Routing Guard

## Problem

Final Review routing is a VibeCodingAssistant-ElonMa-owned decision point. The LLM can advise whether a failed final review should be completed, sent back to implementation, sent back to planning, or surfaced to the user, but it must not be the only safety layer.

The failure mode found on 2026-05-26 was:

1. Final Review reported a concrete implementation/test defect.
2. The routing advisor returned `ask_user_direction`.
3. The advisor did not include a structured `userDecision`.
4. VibeCodingAssistant-ElonMa paused with an internal formatting error instead of giving the user an actionable choice.

From the user's perspective, "VibeCodingAssistant-ElonMa" and "Advisor" are both Elon Ma. The code should not expose internal role-format errors as normal workflow guidance.

## Rule

VibeCodingAssistant-ElonMa keeps deterministic guardrails after Final Review:

- Technical defects default to implementation follow-up.
- Plan/design mismatches can route back to planning.
- Product, scope, UX, cost, or direction tradeoffs can ask the user.
- If a user decision is needed but the advisor omits structured A/B/C/D options, VibeCodingAssistant-ElonMa generates safe fallback options.

Technical defects include test failures, integration failures, Playwright/Vitest failures, lint/build/typecheck failures, runtime regressions, and contained implementation bugs.

## Follow-Up Cap

VibeCodingAssistant-ElonMa still limits automatic Final Review follow-up loops. After the automatic follow-up budget is used, repeated implementation blockers pause with explicit options:

- A. Run another follow-up
- B. Send back to planning
- C. Accept with deferred issues
- D. Stop task

This cap is VibeCodingAssistant-ElonMa-generated. It should not rely on the routing advisor to produce the options.

## Current Dirty Task Recovery

If an old task is already paused with an invalid Final Review Advisor message, the code fix will not rewrite that historical state automatically.

For that task, reply in the Project Chat with an explicit direction, for example:

```text
继续修复：按 final review 的 B1 建议，把 epubWordAnchorProvider.ts 里的 100ms reportLocation suppression 改成 one-shot / same-page-only 防护，不能吞掉真实 relocated page-turn cleanup event。修完后重跑 Reader.manualInterlinear.integration.test.tsx 和相关 Playwright/test。
```

Then, when VibeCodingAssistant-ElonMa says it has recorded the direction and is ready, reply:

```text
approve A
```

New tasks should use the guarded route automatically.
