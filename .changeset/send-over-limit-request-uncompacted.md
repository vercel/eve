---
"eve": patch
---

A request that compaction can't bring under the compaction threshold is now sent uncompacted, so the provider decides whether it fits, instead of ending the session with `COMPACTION_FAILED`.

eve logs a warning, and a compaction that already started still settles `failed`. If the provider rejects the request as too long, the session ends with the provider's error. Thanks @zackleman for reporting this and for the implementation plan in #5921.
