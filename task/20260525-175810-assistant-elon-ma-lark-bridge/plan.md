# Plan (revised): Tighten Assistant action-execution contract for Lark bridge

**Category:** Assistant / Workflow

## Reconciliation note
The original prompt claims `answer_user_direction` is missing. It is not. The tool is defined (`src/adapters.ts:521`), allowlisted for `waiting_user_direction` (`src/adapters.ts:318`), exposed through `bridgeToolNamesForTaskStatus` (`src/adapters.ts:661`), state-asserted (`src/bridgeAgent.ts:464`), executed (`src/bridgeAgent.ts:327`), and covered by a happy-path test (`tests/bridgeAgent.test.ts:282`). The real defect is contract enforcement: in `waiting_user_direction` the model can ship a neutral acknowledgement or `reply_to_user` instead of `answer_user_direction`, and the workflow stalls. This revision adds a backend, state-aware guard (per reviewer Finding 1) on top of the original prompt + regex tightening.

## Execution Unit 01: Audit current contract surface (no code change)

- Verify the end-to-end wiring listed above is intact.
- Verify fallback routing of stale `approve_plan` / `accept_task` / `revise_plan` while in `waiting_user_direction` already redirects to `answerUserDirection` (`src/bridgeAgent.ts:285`, `:305`, `:345`).
- Verify `assertToolAllowedForState` covers `answer_user_direction` (`src/bridgeAgent.ts:464`).
- Output: one short paragraph at the top of the implementation log stating "tool exists; defect is contract enforcement, not tool surface" so the implementer doesn't re-add what's already there.

## Execution Unit 02: Strengthen `FAKE_STATE_CLAIM_PATTERN`

File: `src/bridgeAgent.ts:63` (and matching branches in `inferFakeClaimIntent` at `src/bridgeAgent.ts:975`).

- Extend the regex to cover soft-future / acknowledgement claim phrasings, while keeping each alternation anchored to a first-person subject **or** a workflow noun (per reviewer Finding 3). Add (non-exhaustive):
  - `我会(记录|反馈|提交|推进|转交)`
  - `我来(记录|反馈|提交|推进)`
  - `帮你(记录|反馈|提交|推进|转交)`
  - `(反馈|提交|转交)给.*?(workflow|工作流)`
  - `(马上|现在|立刻|稍后).*(推进|反馈|记录|提交).*(workflow|工作流|流程)`
- Do **not** add the broader `收到.*(推进|反馈|记录|提交)` form proposed in the prior plan — it false-positives on quote-back text. The mitigation is in the pattern, not in tests alone.
- Mirror these in `inferFakeClaimIntent` so the "原本想做的" line reads "记录用户选择并反馈给 workflow" for the new phrasings.
- Keep guard purely lexical and deterministic.

## Execution Unit 03: State-aware enforcement for `waiting_user_direction` (Reviewer Finding 1, Blocking)

This is the new layer. Even with the regex tightened, neutral replies like `收到。` / `好的，我理解你的选择。` / a `reply_to_user` tool call with bland text must not slip through when the task is waiting on a direction answer.

File: `src/bridgeAgent.ts`.

- Introduce a helper `looksLikeUserDirectionAnswer(text: string, pendingPrompt?: string): boolean` that returns true for any of:
  - Bare numeric option (`^\s*[1-9][0-9]?\s*[。.!\s]?$`).
  - Single ASCII option letter (`^\s*[A-Da-d]\s*[。.!\s]?$`).
  - Short message (≤ 30 chars after trim) when `pendingPrompt` is set and the task is in `waiting_user_direction` (covers "选 1，我同意"/"就 A 吧").

  Used only to decide *whether the latest user turn was an answer attempt*, not to filter assistant output.

- Modify `replyGuarded` (`src/bridgeAgent.ts:410`) and the `reply_to_user` branch (`src/bridgeAgent.ts:254`):
  - When `input.task.status === 'waiting_user_direction'` and `looksLikeUserDirectionAnswer(latestUserMessageText, input.task.pendingUserPrompt)` is true, route to `this.answerUserDirection(input.task.taskId, latestUserMessageText)` **instead of** sending the assistant's plain reply. This deterministically converts the model's text reply into the missing tool call. Audit action: `guard:direction-autoanswer`.
  - When the same status holds but the latest user message does not look like an answer (e.g. user asked a clarifying meta-question), and the assistant's reply *also* doesn't trip `FAKE_STATE_CLAIM_PATTERN`, fall through to `replyNoOp` with a new reason "task 在 waiting_user_direction，纯文本回复不能推进 workflow，请使用 answer_user_direction". Audit action: `guard:direction-text-blocked`. This prevents the "好的" / "收到" leak class.
  - Keep the existing fake-claim path (`guard:fake-claim`) for any state where the regex matches.
- For these branches to work, `NoOpState` (`src/bridgeAgent.ts:61`) must expose `pendingUserPrompt?: string`. Extend `NoOpState = Pick<TaskState, 'status' | 'pendingUserPrompt'>` and confirm callers pass the full `task`/`state` (they do — verify at the four call sites).
- The latest user message text is reachable through `input` (or through the `request` already threaded in `handleMessage` at `src/bridgeAgent.ts:155`). Prefer `input` since `replyGuarded` already receives it; if not present on `BridgeAgentInput`, thread `latestUserMessage` from `handleMessage` into `replyGuarded` rather than re-deriving.

## Execution Unit 04: Make `replyNoOp` state-aware and directive

File: `src/bridgeAgent.ts:421` (`replyNoOp`).

- When `state.status === 'waiting_user_direction'` and `state.pendingUserPrompt` is set, prepend one line above the existing block:
  - `当前 task 正在等你回答下面这个问题，必须用 \`answer_user_direction\` 提交答案，不能用普通文字回复推进 workflow：` followed by the truncated `pendingUserPrompt` (≤ 200 chars).
- Other states unchanged.
- Do not echo the rejected model text (existing behavior; preserve).

## Execution Unit 05: Sharpen the `decideBridgeAction` system prompt

File: `src/adapters.ts:939` (the `waiting_user_direction` sentence inside the `decideBridgeAction` system content block at `src/adapters.ts:932-954`).

- Replace the single sentence with a tighter two-sentence rule that does not enumerate other tools:
  - "If task.status is `waiting_user_direction`, any reply that addresses the pending question — including a bare number, an option letter, or a sentence explaining the choice — **MUST be sent via `answer_user_direction`**. Plain text is allowed only when you are genuinely asking the user a clarifying question back; in that case do not claim you will record, forward, or feed anything to the workflow."
- Do not add per-status `if` branches to the prompt — the tool surface and the new state-aware guard already enforce what is callable.
- Leave all surrounding prompt paragraphs alone.

## Execution Unit 06: Regression tests (Reviewer Findings 2 and 4)

File: `tests/bridgeAgent.test.ts` for behavior, `tests/adapters.test.ts` for the prompt smoke test.

All new tests use a `waiting_user_direction` fixture with `pendingUserPrompt` set and the latest user message set to a plausible answer.

- **Test A — regex still catches soft-future claim.** Assistant returns `{ kind: 'reply', text: '收到，我会把你的选择 1 反馈给 workflow。' }`. Expect a no-op turn whose message contains the pending question and references `answer_user_direction`; task status unchanged.
- **Test B — `replyNoOp` surfaces `pendingUserPrompt`.** Same fixture as A; assert the outgoing message includes the truncated `pendingUserPrompt`.
- **Test C — neutral acknowledgement is blocked (new layer).** Assistant returns `{ kind: 'reply', text: '好的，我理解你的选择。' }` while user message is `1`. Expect either (a) auto-routed `answer_user_direction` invocation (preferred — `guard:direction-autoanswer`) or (b) a no-op message tagged `guard:direction-text-blocked`. Implementer chooses (a) for numeric answers; (b) for non-answer user messages. Assert workflow advanced in case (a).
- **Test D — `reply_to_user` misuse is blocked.** Assistant returns a `tool_call: reply_to_user` with bland acknowledgement (`text: '好的'`) while user message is `1`. Same expectation as Test C — must not pass through as a plain reply; workflow must advance via `answer_user_direction`. (Directly addresses reviewer Finding 2.)
- **Test E — happy path unchanged.** Existing test at `tests/bridgeAgent.test.ts:282` must keep passing without modification.
- **Test F — guard does not false-positive on legitimate clarifying questions.** Assistant returns `{ kind: 'reply', text: '你说的选项 1 是指 accept 还是 revert？' }`. Should pass through as a normal reply (model is genuinely asking back); workflow unchanged but no no-op message emitted.
- **Test G — prompt smoke (mandatory, was optional).** In `tests/adapters.test.ts`, build the system prompt for `decideBridgeAction` and assert it contains the literal substring `` MUST be sent via `answer_user_direction` ``. This guards against silent prompt drift. (Reviewer Finding 4.)

## Risks / tradeoffs
- The state-aware auto-route (Unit 03 / Test C path "a") can convert an unintended short message into a workflow answer. Mitigation: gate on `looksLikeUserDirectionAnswer` heuristics that are conservative (numeric/letter/very short), and surface the routed answer in the workflow message so the user sees what was submitted.
- Prompt edits drift in tone over time. Mitigation: Test G locks the rule substring.
- Tightened regex still risks edge-case false positives. Mitigation: Test F covers a known false-positive class; if more surface, adjust patterns, don't widen anchor terms.

## Verification Commands
- npm test
- npx tsc --noEmit
