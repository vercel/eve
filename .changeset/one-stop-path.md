---
"eve": patch
---

Every run a session stops now stops the same way: it's told to stop, gets until the cleanup deadline to finish, and is cancelled outright if it's still running. Cancelling a `task()` used to tell its run and move on; now it also cancels a run that ignores the cancel. A session that ends mid-turn now also stops the workflow tool calls its turn was waiting on.
