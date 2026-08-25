---
"eve": patch
---

Reconnect session streams when browser response-body reads fail with vendor-specific `TypeError` messages, while keeping initial fetch retries limited to known transport errors.
