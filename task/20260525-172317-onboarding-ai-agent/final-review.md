**Blocking Issue**
- `docs/agent-setup-guide.md:18` and `docs/agent-setup-guide.md:22` tell agents to inspect `.env.local`, while `docs/agent-setup-guide.md:72` only forbids reading secrets aloud/printing/summarizing/committing them. The task explicitly required the agent guide to say agents must not read real secrets. This should be tightened to say agents may only verify env var names/presence/non-empty status and must not open, read, echo, or report secret values.

**Verification Rerun**
- `npm run assistant -- projects --config assistant.config.local.json`: passed; listed configured projects. I’m not repeating local paths.
- `npm run build`: passed.
- `npm test`: passed, 16 files / 139 tests. Same Node `[DEP0190]` warnings appeared.

**Other Checks**
- README / START_HERE / beginner guide / agent guide links resolve.
- I found no real API keys or this-machine private paths introduced in the target docs; only placeholders/examples.
