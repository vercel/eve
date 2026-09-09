---
"eve": patch
---

Validate session inbox commands against the receiving session's protocol through typed version migrations, while preserving the fast path for legacy-compatible commands. Background workers receive an explicit compatibility error when an older parent cannot execute an agent request, instead of waiting indefinitely.

Cancellation of session-owned tasks on older sessions now returns HTTP 409 with code `SESSION_INBOX_INCOMPATIBLE`, instead of a generic server error. The request is rejected before delivery.
