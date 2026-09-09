---
"eve": patch
---

Hooks can inspect a completed conversation response with `beforeResponseRelease` and return `"skip"` to suppress terminal channel delivery. Earlier events, model history, and external side effects remain unchanged.
