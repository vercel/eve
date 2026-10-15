---
"eve": patch
---

When a tool throws, the error on its `tool.call.failed` instrumentation event now keeps the thrown error's `name`, such as `QuotaError`, instead of always reading `Error`. The `action.result` stream event reports the same name as `error.name`.
