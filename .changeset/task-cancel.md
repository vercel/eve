---
"eve": patch
---

Add the `task_cancel` framework tool (`eve/tools/task_cancel`): in sessions that can have background tasks, the model can stop background tasks by ID and gets back `{ cancelled, alreadyFinished, unknown }`; a stopped task emits `task.settled` with `status: "cancelled"` and never reports back, while a task that already finished still delivers its result. `session.cancel({ taskId })` stops one background task and leaves the turn running, and `session.cancel({ tasks: true })` cancels the active turn and every working task, on the client, on channel `Session` handles, and on the eve channel's cancel route.
