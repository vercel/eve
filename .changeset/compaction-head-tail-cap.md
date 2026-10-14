---
"eve": patch
---

Compaction now keeps the start and end of an oversized tool result instead of only its start, so failures, errors, and the `bash` exit code at the end of the output survive.
