---
"eve": major
---

`session.clear()` now cancels a running turn and every working task before it clears history, instead of waiting for the turn to finish.

Previously a clear sent while a turn waited on tasks didn't run until the tasks finished, and never ran if one hung. Tasks a clear stops end with `task.ended` `outcome: "cancelled"`, and no task result the cleared conversation hadn't read reaches the next turn.
