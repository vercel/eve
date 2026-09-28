---
"eve": patch
---

Turn-scoped dynamic tools now restore their durable callbacks when a turn resumes in a different process, so tools resolved at `turn.started` remain callable throughout the turn.
