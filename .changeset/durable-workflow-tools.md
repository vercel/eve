---
"eve": patch
---

A tool's `execute` can now be a Workflow body: start it with `"use workflow"`, write helpers as `"use step"` functions, and use `createHook`, `createWebhook`, `sleep`, and `start` from `workflow` and `workflow/api`. eve runs each call as a durable run and, by default, parks the turn until it returns. Import `ask` from `eve/workflow` to ask the human on the channel — it returns the hook the answer resumes, awaitable once, raceable against a `sleep` deadline, or iterable as a standing question — and the request stays answerable even after the turn that started it ended. A workflow body may be an async generator whose `yield`s are durable progress. `ctx.abortSignal` aborts on cancellation so steps can stop and `finally` can clean up. With `execution: "background"` the model gets a receipt and is woken with the result. eve also serves the Workflow webhook route so `createWebhook()` URLs work.
