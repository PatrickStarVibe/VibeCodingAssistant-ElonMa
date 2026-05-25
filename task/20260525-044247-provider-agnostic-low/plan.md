Category: Assistant / Workflow

**Parent Task**
Provider-agnostic configuration layer cleanup.

**Current Findings**
The config path is centered in `src/config.ts`, `src/types.ts`, and `src/adapters.ts`. Current defaults and examples are still provider-specific: assistant is forced to `deepseek`, heavy roles are limited to `codex` / `claude`, and `.env.example` does not exist. `.gitignore` already ignores local config and `logs`, but it should explicitly cover `.env.local`, local env variants, runtime state, and agent-local files.

**Execution Unit 1: Config, Examples, Errors, Tests**
Implement this as one focused unit.

Update the profile schema and normalization so each profile supports `kind` / `provider`, `model`, optional `baseUrl`, `apiKeyEnv`, and optional `command`, while preserving backward compatibility for existing `deepseek`, `codex`, and `claude` local configs.

Make the assistant chat adapter provider-agnostic for OpenAI-compatible `/chat/completions` providers. It should use the configured `baseUrl`, `model`, and `apiKeyEnv`, and error clearly when `apiKeyEnv` is missing or the referenced env var is unset. Keep no API keys in repo.

Keep heavy workflow execution on the existing command-driven path, but remove silent command defaults. If a role profile requires a CLI command and `command` is missing, fail before spawning with a message naming the role, profile, and missing field. Do not change workflow state transitions or introduce provider SDKs.

Add lightweight `.env.local` loading before config/adapters need env values, without adding a provider SDK. Existing process env should still win or be documented clearly.

Rewrite `assistant.config.example.json` to use neutral profile names and placeholder provider/model/env names, with examples for compatible API profiles and command-backed agent profiles. Add `.env.example` showing required env names for Lark plus generic provider keys. Do not hard-code DeepSeek, Codex, or Claude as the assumed setup.

Update docs where they currently say DeepSeek/Codex/Claude are required defaults, especially `docs/lark-bridge.md`, to explain provider-agnostic configuration and local-only secrets.

Expand `.gitignore` for `.env`, `.env.local`, `.env.*.local`, local assistant config/project registries, `logs/`, runtime state, `*.log`, and agent-local runtime folders, while keeping `.env.example` trackable.

Add tests for:
- example config loads successfully;
- API profile can use a non-DeepSeek provider/base URL/env var;
- missing API key error is readable;
- missing command error is readable;
- config/tests do not require a fixed provider.

**Verification Commands**
```powershell
npm test
npm run build
```
