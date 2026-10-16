---
"eve": patch
---

A turn step no longer reports what comes next. The session now decides from the state the step leaves whether the turn runs again or waits on a person, on calls, or on tasks, using one function that a Lean model in `formal/` proves things about. `waiting()` now reads a parked `eve__task_wait` as waiting on work, not as work the session is doing itself. In `eve dev`, eve now checks that decision against the session's tables after every durable step.
