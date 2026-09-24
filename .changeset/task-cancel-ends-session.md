---
"eve": patch
---

Cancelling the turn of a task-mode session with no caller, such as a scheduled run, now ends the session with `session.completed` instead of leaving the run parked until it times out. The result reports that the turn was cancelled.
