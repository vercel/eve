---
"eve": patch
---

The terminal UI's `/new`, `/clear`, and `/compact` now come from the eve channel's default commands, exported as `sessionCommands` from `eve/channels` with `/cancel` for other clients.

`eveChannel()` always offers them, and a `commands` record adds to them. Pass `commands` as a function, `(defaults) => ({ ... })`, to change or drop them. When an agent doesn't offer one of them, the terminal UI says so instead of sending it to the model. `/cancel` stays built into the terminal UI, since it cancels the turn the UI is showing; Esc and Ctrl+C still cancel too.
