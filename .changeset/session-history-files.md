---
"eve": minor
---

User entries in session `history` now accept `{ type: "file" }` parts alongside text, reusing eve's attachment resolution and sandbox staging.

Supply `{ type: "file", mediaType, filename?, data }` (`SessionHistoryFilePart`, exported from `eve/channels` and `eve/evals`) inside a user message's `parts` on channel `create()`, `send()`, `onMessage.history`, or local eval `t.session({ history })`. Imported files resolve through the channel's `fetchFile` hook or SSRF-safe public HTTPS download under a shared 10-download cap, enforce `uploadPolicy`, stage into the sandbox during turn intake and interrupted-turn recovery, record safe metadata (`ImportedFilePart` from `eve/events`) on `delivery.consumed` without persisting inline bytes, and render as `EveFilePart` in frontend `EveMessage`.

Thanks @FranciscoMoretti for the request and ChatJS fork reference in #5340.
