---
"eve": patch
---

The terminal UI's `/new`, `/clear`, and `/compact` now come from the eve channel's default commands, exported as `sessionCommands` from `eve/channels` with `/cancel` for other clients.

`eveChannel()` offers them when `commands` is omitted. An agent that passes its own `commands` keeps them by spreading them in: `commands: { ...sessionCommands, escalate }`. When an agent doesn't offer one of them, the terminal UI says so instead of sending it to the model. `/cancel` stays built into the terminal UI, since it cancels the turn the UI is showing; Esc and Ctrl+C still cancel too.
