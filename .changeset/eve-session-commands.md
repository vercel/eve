---
"eve": patch
---

The terminal UI's `/new`, `/clear`, and `/compact` now come from the eve channel's default commands, exported as `sessionCommands` from `eve/channels`.

`eveChannel()` always offers them, and a `commands` record adds to them. Pass `commands` as a function, `(defaults) => ({ ... })`, to change or drop them. `/cancel` stays built into the terminal UI, since it cancels the turn the UI is showing; Esc and Ctrl+C still cancel too.
