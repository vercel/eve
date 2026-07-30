---
"eve": patch
---

An accepted turn-cancel request now explicitly re-enqueues the target session's workflow run instead of relying on the workflow world to reschedule it when the cancel hook is resumed. A parked session whose wake was dropped by the scheduler previously held an accepted cancel indefinitely without emitting `turn.cancelled`.
