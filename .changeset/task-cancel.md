---
"eve": minor
---

`session.cancel()` now stops the active turn, its attached calls, and every working task, whichever turn started it, and the model stops one task with `task_cancel({ taskId })`, which returns `{ status: "cancelled" | "already_finished" }`. Idle agents and resumable tasks stay available after either.

With no active turn, `session.cancel()` is no longer a no-op: it stops every working task, or, when it names a `turnId`, only the tasks that turn started, so a late cancel for a finished turn never stops a newer turn's work.

Upgrading:

- `task_cancel` takes one `taskId` instead of `taskIds`, refuses a task another principal started with `TASK_OTHER_PRINCIPAL`, and also stops input queued for the task. eve offers it, with `task_wait`, in every session whose agent can start a detached task.
- The `tasks` option of the client's `session.cancel()`, and the `taskId` and `tasks` options of channel `Session.cancel()` and `POST /eve/v1/session/:sessionId/cancel`, are removed. The route answers `400` and channel sessions throw a `TypeError` for either option.
- A turn failure or session expiry cancels the turn's working tasks. When a session ends, every task ends, idle ones included, and each agent it started ends its own session and agents; a local agent or workflow run still running 30 or 35 seconds later is stopped outright. Cancelling no longer waits for a workflow tool run to stop.
