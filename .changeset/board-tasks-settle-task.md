---
"@eve/board": minor
---

Add `tasks`, which lists a queue's tasks with their state, holder, and owner, and `settle_task`, which claims a ready task by its ID and marks it completed or failed in one call, after the caller approves, so an agent can record work done elsewhere, such as a merged pull request. `authorize` receives `settle_task` with the task's ID.
