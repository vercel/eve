---
"eve": patch
---

Retry transient Windows file-sharing errors when reading local workflow state, matching the bounded retries already used for writes. Persistent access errors and malformed state still fail.
