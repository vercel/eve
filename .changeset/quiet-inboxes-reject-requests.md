---
"eve": patch
---

Validate task deliveries against the receiving session's protocol while preserving the fast path for commands that fit the frozen legacy contract. Background workers receive an explicit compatibility error when an older parent cannot handle an agent request, instead of waiting indefinitely.
