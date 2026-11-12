---
"eve": patch
---

Answers eve discards, such as an empty answer it asks the model for again or a `content-filter` answer that fails the turn, now record their usage on the session stream and count toward session usage and `limits.sessionUsage`, like a steered answer always has.

A reissued answer's `usage.recorded` follows its `model.retried`; a failed run's follows its `model.settled`. Thanks @zackleman for reporting this in #5918.
