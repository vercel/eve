---
"eve": patch
---

Fix workflow hook ownership checks and preserve workflow error types and retry timing.

`hook.getConflict()` now returns the existing owner's run ID inside workflow bodies. `FatalError` and `RetryableError` caught from steps retain their class identity, and workflow-created `RetryableError` values honor `retryAfter`.
