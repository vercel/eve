---
"eve": patch
---

A task run that completes or fails while one of its `ctx.ask()` questions is still pending now reports that question as `input.resolved` with `outcome: "cancelled"`, as `task_cancel` already did. Before, the question disappeared without an event, so channels and clients kept offering a question nobody could answer.
