---
"eve": patch
---

Sessions that started on eve 0.69 through 0.83 and delegated to a subagent now move to the new deployment instead of staying on the old one until they end.

An idle resumable task no longer keeps such a session on its earlier deployment: the move ends the task's old run, and the model starts a new task on the current build when it needs one. A task that is still working, or has results the model hasn't read, still keeps the session where it is until that clears.

Thanks @zackleman for reporting this and for the implementation plan in #5927.
