## Execution Unit 01: Main

Implemented the provider-agnostic config cleanup.

Changed files:
- [assistant.config.example.json](C:/Users/24600/OneDrive/文档/Manager/assistant.config.example.json)
- [src/config.ts](C:/Users/24600/OneDrive/文档/Manager/src/config.ts)
- [src/adapters.ts](C:/Users/24600/OneDrive/文档/Manager/src/adapters.ts)
- [tests/config.test.ts](C:/Users/24600/OneDrive/文档/Manager/tests/config.test.ts)
- [tests/adapters.test.ts](C:/Users/24600/OneDrive/文档/Manager/tests/adapters.test.ts)

Summary:
- Removed active provider/model defaults from `defaultConfig()` and the example config.
- Kept DeepSeek support only as explicit legacy normalization from `kind: "deepseek"` to an OpenAI-compatible profile.
- Renamed adapter internals from DeepSeek-specific message/tool names to generic chat completion names.
- Made assistant chat reject command-backed profiles and require `model`, `baseUrl`, and `apiKeyEnv`.
- Kept heavy-agent dispatch scoped to command-backed profiles.

Test Result:
- Focused: `npm test -- tests/config.test.ts tests/adapters.test.ts` passed, 2 files / 23 tests.
- Full: `npm test` passed, 16 files / 135 tests. It emitted existing Node `DEP0190` child-process warnings.
- Build: `npm run build` passed.
