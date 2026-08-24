---
"eve": patch
---

Prevent restored client sessions with stale stream cursors from returning an older turn's result. Existing-session routes now return the pre-dispatch stream position so `send()` and `respond()` can skip previously durable events.
