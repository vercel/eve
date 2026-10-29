---
"eve": minor
---

`session.clear()` now cancels the running turn and stops working tasks before it clears history, instead of waiting for the turn to finish.

Previously a clear sent while a turn waited on tasks didn't run until the tasks finished, and never ran if one hung. Tasks a clear stops end with `task.ended` `outcome: "cancelled"`, and their results never reach the cleared conversation.
