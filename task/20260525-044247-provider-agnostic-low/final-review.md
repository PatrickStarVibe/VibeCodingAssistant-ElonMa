**Findings**
- **Blocking:** [src/adapters.ts](C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:7) imports `runFile`, then imports it again at [src/adapters.ts](C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:36). This matches the reported `npm test` / `npm run build` failure and prevents the project from compiling.

- **Blocking:** missing `command` is still silently defaulted for `codex` / `claude` profiles. [src/adapters.ts](C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:1256) returns `fallbackCommand`, and the callers pass `'codex'` / `'claude'` at [src/adapters.ts](C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:1279) and [src/adapters.ts](C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts:1321). This violates the requirement that missing `command` fails clearly before spawning.

- **Blocking:** config normalization can mask missing `apiKeyEnv` / `command` for default profile names. [src/config.ts](C:/Users/24600/OneDrive/文档/Manager/src/config.ts:182) seeds defaults, then [src/config.ts](C:/Users/24600/OneDrive/文档/Manager/src/config.ts:166) and [src/config.ts](C:/Users/24600/OneDrive/文档/Manager/src/config.ts:167) inherit `apiKeyEnv` / `command` from the base profile. A local config that omits these fields may inherit placeholder values like `ASSISTANT_API_KEY` or `your-agent-cli` instead of producing the required readable missing-field error.

**Verification**
Current verification is not acceptable: `npm test` and `npm run build` both fail on the duplicate `runFile` import. I would not accept this parent task until the compile failure and missing-command/key validation gaps are fixed and covered through `loadConfig`-level tests.
