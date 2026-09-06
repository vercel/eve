---
"eve": patch
---

Validate session deliveries against the receiving session's protocol, including stable inbox tokens and unversioned sessions. Background workers receive an explicit compatibility error when an older parent cannot handle an agent request, instead of waiting indefinitely.
