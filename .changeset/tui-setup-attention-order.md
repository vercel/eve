---
"eve": patch
---

The dev TUI startup attention line now lists an unmet Vercel auth prerequisite (`/vc` to install the CLI, `/login` to sign in) ahead of the `/model` hint it gates. Linking a project to fix the `/model` hint needs a working CLI and a logged-in session, so the line points you at the step you can actually complete first.
