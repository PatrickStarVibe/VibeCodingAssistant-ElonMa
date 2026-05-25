Category: Docs / Task Record

Parent Task: Add provider-agnostic beginner onboarding and AI agent setup documentation.

Execution units:

1. Create `START_HERE_FOR_BEGINNERS.md`
   - Explain what Manager / Assistant Elon Ma is in beginner-friendly language.
   - Walk through prerequisites: Node/npm, repo files, provider account/API key or provider command, Lark credentials if using bridge, target project path.
   - Explain copying `.env.example` and `assistant.config.example.json` into local files.
   - Explain how to fill `.env.local` without exposing secrets.
   - Explain how to configure `workspace.targetDir`, `defaultProjectId`, `projects[]`, `docsDir`, and optional `assistant.projects.local.json`.
   - Include validation steps for `projects`, a smoke task, `agent-prompt-preview`, and Lark bridge startup.
   - Cover common errors: missing API key, config missing, project path invalid, provider command not found, Lark credentials missing, Node/npm missing.
   - Link to `START_HERE.md`, `docs/lark-bridge.md`, and `docs/agent-setup-guide.md` instead of duplicating large sections.

2. Create `docs/agent-setup-guide.md`
   - Tell coding agents to read `README.md`, `START_HERE.md`, `START_HERE_FOR_BEGINNERS.md`, `.env.example`, `assistant.config.example.json`, `docs/lark-bridge.md`, and relevant config files.
   - List the exact user information to ask for: project id/name/path, docs path, provider profile details, env var names, Lark env var names/open IDs/chat IDs.
   - State editable local files only: `.env.local`, `assistant.config.local.json`, `assistant.projects.local.json`.
   - State forbidden behavior: do not read aloud, print, commit, or persist real secrets outside local secret files; do not hard-code one provider.
   - Include validation commands and expected non-secret checks.

3. Update cross-links only
   - Update `README.md` to link to beginner and agent guides.
   - Update `START_HERE.md` with short links to `START_HERE_FOR_BEGINNERS.md` and `docs/agent-setup-guide.md`.
   - From both new docs, link back to `README.md` and `START_HERE.md`.
   - Avoid large duplicated START_HERE sections.

Acceptance criteria:
- Provider-agnostic wording throughout.
- No real API keys, tokens, secrets, or machine-specific private paths introduced.
- Beginner guide is usable by someone who does not know command line basics.
- Agent guide gives clear permission boundaries and verification workflow.
- README, START_HERE, beginner guide, and agent guide link to each other correctly.

**Verification Commands**
```powershell
npm run assistant -- projects --config assistant.config.local.json
npm run build
npm test
```
