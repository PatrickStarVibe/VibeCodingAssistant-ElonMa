## Execution Unit 01: Main

Implemented the onboarding docs and cross-links.

Changed files:
- `START_HERE_FOR_BEGINNERS.md`
- `docs/agent-setup-guide.md`
- `README.md`
- `START_HERE.md`

Notes:
- Beginner guide covers setup, local config copying, `.env.local`, project paths, provider profiles, validation, Lark bridge startup, and common errors.
- Agent guide defines read order, required user inputs, editable local files, secret-handling rules, and verification workflow.
- README / START_HERE / beginner guide / agent guide now link to each other.
- No real secrets or private machine paths were added to the touched docs.

Test Result:
- `npm run assistant -- projects --config assistant.config.local.json`: passed; listed configured projects.
- `npm run build`: passed.
- `npm test`: passed, 16 test files / 139 tests. Vitest emitted existing Node `[DEP0190]` deprecation warnings, but all tests passed.

One repo-state detail: `README.md` is currently untracked in git status, while `START_HERE.md` is modified. There were also unrelated pre-existing dirty files that I did not touch.
