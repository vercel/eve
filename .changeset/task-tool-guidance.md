---
"eve": patch
---

Models now get clearer task guidance: call `task_wait` when there's nothing to say until a result arrives, reply when the person should hear something first, and in child and schedule sessions wait instead of replying. `task_wait` takes `timeoutSeconds` instead of `timeout` in milliseconds, `task_cancel` answers in plain text, and receipts and failed agent results tell the model what happens next.
