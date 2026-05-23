# AGENTS

Project context lives in [CLAUDE.md](./CLAUDE.md). This file is for cross-agent operational notes that don't belong in the project description.

## Lessons

Append a one-line lesson whenever the user corrects your approach. Keep entries terse and load-bearing — the *rule*, not the story. Newest at the top.

<!-- example format:
- **Don't X.** Why: Y. How to apply: Z.
-->

- **Don't trim `BusinessContext` fields just because the current frontend doesn't read them.** Why: it's the API contract for slice 1; all fields are intentional even if no consumer reads them today. How to apply: treat `src/backend/main.py::BusinessContext` as load-bearing — never drop fields as "bloat", even with no callers.
