---
"eve": minor
---

`turn.paused` now lists person-facing interactions in `awaiting`; turns waiting only on tasks keep running, and `turn.resumed` is removed. Text produced while waiting on tasks is narration rather than a final reply, and `eve invoke` ends a run that needs a person with an `input-required` status.
