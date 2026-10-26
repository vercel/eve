---
"eve": patch
---

A compaction summary call that fails during a turn, for example on a provider 429 that outlasts its retries, now fails that turn with `MODEL_CALL_FAILED` and leaves the session waiting with its history uncompacted. Previously the error escaped the turn step, so eve re-ran the step, repeating its events, and then ended the session with `session.failed`. Thanks to @gshost1 for the report and reproduction.
