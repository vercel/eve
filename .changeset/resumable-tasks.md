---
"eve": minor
---

Workflow tools can define `serve(receive, ctx)` to run a resumable task: `receive()` resolves the call that started the task, then each later call the model makes with the task's `taskId`, and `ctx.reply(output)` delivers a result while the task stays available. eve adds an optional `taskId` to a `serve` tool's model input (the build fails if `inputSchema` declares its own), idle tasks don't hold the turn and are listed in the `[Tasks]` note, and `task_cancel` aborts the current work's `abortSignal` while the task stays available for its next call.
