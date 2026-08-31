---
"eve": patch
---

A tool's `execute` can now be a Workflow body: start it with `"use workflow"`, write helpers as `"use step"` functions, and use `createHook`, `createWebhook`, and `sleep` from `workflow` in the body and `start`, `getRun`, and `resumeHook` from `workflow/api` in steps. eve runs each call as a durable run and, by default, parks the turn until it returns. Import `ask` from `eve/workflow` to ask the human on the channel — it returns the hook the answer resumes, so it can be awaited or raced against a `sleep` deadline — and the request stays answerable even after the turn that started it ended. A workflow body may be an async generator whose `yield`s are durable progress. `ctx.abortSignal` aborts on cancellation, and the run waits a grace period for steps to stop and `finally` to clean up. With `execution: "background"` the model gets a receipt and is woken with the result. eve also serves the Workflow webhook route so `createWebhook()` URLs work.
