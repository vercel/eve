---
"eve": patch
---

`eve init` now offers to open an installed coding-agent REPL when its CLI is on `PATH`, while keeping `eve dev` as the default. It detects Claude Code, Codex, Cursor, Droid, Gemini CLI, opencode, and Pi. The selected REPL starts with a project-specific setup prompt and `eve dev --no-ui` verification guidance. Coding-agent and non-interactive launches, plus systems without any supported CLI, keep the existing development-server handoff.
