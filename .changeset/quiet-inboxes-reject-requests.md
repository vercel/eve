---
"eve": patch
---

Validate session inbox commands against the receiving session's protocol through typed version migrations, while preserving the fast path for legacy-compatible commands. Background workers receive an explicit compatibility error when an older parent cannot execute an agent request, instead of waiting indefinitely.
