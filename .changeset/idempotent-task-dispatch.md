---
"eve": patch
---

Fix a workflow tool task running twice when the session was interrupted while publishing `task.started`, for example during a slow `task.started` hook. The session now records each task's run before it publishes the event, so a retry only publishes `task.started` again and never starts a second run.
