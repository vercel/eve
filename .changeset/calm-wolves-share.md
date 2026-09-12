---
"eve": patch
---

Use an installed Codex CLI's app-server for ChatGPT subscription credentials, while retaining eve's direct sign-in and owned credential store as a fallback only when the `codex` binary is not found. Codex login output remains inside the model setup panel instead of writing directly over the TUI.
