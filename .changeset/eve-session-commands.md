---
"eve": patch
---

The terminal UI's `/new`, `/clear`, `/compact`, and `/cancel` are now the eve channel's default commands, exported as `sessionCommands` from `eve/channels`.

`eveChannel()` offers them when `commands` is omitted. An agent that passes its own `commands` keeps them by spreading them in: `commands: { ...sessionCommands, triage }`. Esc and Ctrl+C still cancel a running turn whatever commands the agent offers.
