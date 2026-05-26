**Review Decision:** Approve with no new blockers. The execution-unit breakdown is coherent, dependencies are ordered correctly, and the revised plan closes the active ledger issues.

The plan intentionally diverges from the literal `MANAGER_API_KEY` / `MANAGER_AGENT_ID` wording by deriving env vars from config. Given the stated prior direction and the provider-agnostic runtime contract, that is acceptable, but implementation should keep the docs explicit so users are not surprised by env names differing from the task text.

**Residual Risks**

- `assistant:start` currently runs preflight twice if the Windows launchers also run preflight before calling it. The plan’s launcher section now says they run `assistant:start` and attributes preflight to that script, so implementation should avoid a separate duplicate `node scripts/preflight.mjs` call.
- The setup wizard scope is large. Keep it conservative: generate/copy config, prompt for missing required fields, and run preflight. Avoid trying to become a full config editor.
- Repo hygiene is correctly kept out of `prepublishOnly`; otherwise publishing would be blocked by the implementation’s own dirty tree during development.
