---
"eve": patch
---

Every workflow tool call now appears on the session stream as a task: `task.started` with `kind: "workflow"` and no `child` when its run starts, then one `task.settled` with its outcome (`START_FAILED` when the run cannot start). Filter `task.*` events by `kind` and `name` if you only follow agent calls. Cancelling a turn no longer waits up to 35 seconds for its workflow tool runs to stop; the runs clean up and report on their own.
