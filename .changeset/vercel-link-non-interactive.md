---
"eve": patch
---

Run `vercel link` non-interactively when connecting a project via the dev TUI `/model` menu (and `eve link`). The link is already fully specified by the team and project picked in the TUI, so the CLI no longer inherits a TTY and can no longer surface its interactive prompts (such as the agent/MCP setup question), which previously corrupted the TUI.
