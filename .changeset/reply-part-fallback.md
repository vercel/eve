---
"eve": minor
---

Reply parts of kinds eve doesn't write, such as a tool's card, now show their `fallbackText` in built-in channels, ACP clients, and the dev TUI, and reach web clients as `content` message parts.

`EveContentPart` carries the part's `kind`, `mediaType`, and `value`, or the raw preview `text` while it streams. Turn reply text read from the session view and eval reply assertions include the fallback text too.
