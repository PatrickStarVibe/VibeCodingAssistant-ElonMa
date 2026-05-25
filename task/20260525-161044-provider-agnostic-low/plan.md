**Parent Task**
Provider-agnostic 配置层整理

**Category**
Assistant / Workflow

**Plan Summary**
Clean up the configuration layer so provider choice is expressed only through profile data, not through provider-specific defaults or naming leaks. Keep this low-scope: preserve existing behavior where practical, avoid schema churn, and focus on config/profile normalization plus adapter naming clarity.

**Execution Unit 1: Provider-Agnostic Config Cleanup**
1. Review `src/config.ts` and keep `defaultConfig()` / `assistant.config.example.json` provider-neutral.
2. Rename or isolate the remaining DeepSeek-specific normalization path. Prefer preserving backwards compatibility for existing `kind: "deepseek"` configs, but make it clearly legacy compatibility rather than a default provider path.
3. Review `src/adapters.ts` for provider-specific names such as `DeepSeekMessage`, `DeepSeekTool`, and `DeepSeekAssistantAdapter`; rename internal types/exports to OpenAI-compatible or generic chat terminology.
4. Keep assistant API validation strict: command-backed profiles should still fail for assistant chat, and OpenAI-compatible profiles should still require `model`, `baseUrl`, and `apiKeyEnv`.
5. Keep heavy-agent CLI dispatch scoped to command providers like `codex` and `claude`; avoid blending chat-provider config with command-runner config.
6. Update focused tests in `tests/config.test.ts` and `tests/adapters.test.ts` to verify neutral defaults, non-DeepSeek compatible provider support, and any retained legacy DeepSeek compatibility.

**Acceptance Criteria**
- Default/example config contains no concrete provider/model defaults.
- Generic OpenAI-compatible profiles work from `baseUrl`, `model`, and `apiKeyEnv`.
- Provider-specific DeepSeek names are removed from active generic code paths, except explicitly retained legacy compatibility.
- Existing config and adapter tests still pass.

**Verification Commands**
```powershell
npm test
npm run build
```
