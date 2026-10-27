---
"eve": patch
---

A compaction that fails during a turn, for example on a provider 429 that outlasts its retries, now fails that turn with `MODEL_CALL_FAILED` and leaves the session waiting with its history uncompacted. Previously the error escaped the turn step, so eve replayed the step and then ended the session. Thanks @gshost1 for the report and reproduction in #5350.
