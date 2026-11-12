---
"eve": patch
---

Sessions that started on eve 0.69 through 0.83 and delegated to a subagent now move to the new deployment instead of staying on the old one until they end.

An idle resumable task no longer keeps such a session on its earlier deployment: the move ends the task's old run, and the model starts a new task on the current build when it needs one. A task that is still working, or has results the model hasn't read, still keeps the session where it is until that clears. A moved session also keeps what it spent, so `limits.sessionUsage` keeps counting from the earlier total and the budget window a person already approved, and a parent session hears only new spend.

Thanks @zackleman for reporting this in #5927.
