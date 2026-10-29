---
"eve": minor
---

`history` passed to `send()`, `create()`, or the eve channel's `onMessage` now rejects an entry with a field other than `id`, `role`, or `text` instead of dropping it.

`InvalidSessionHistoryError` names the entry and its unknown fields. Map stored messages to `{ id, role, text }` before passing them, so fields a later release accepts never change what an existing caller sends.
