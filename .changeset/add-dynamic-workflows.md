---
"eve": patch
---

Add `runWorkflowProgram` for executing a runtime-supplied JavaScript function body inside an authored workflow tool. Generated programs can call only trusted allowlisted agents through the existing durable `ctx.agent` lifecycle.
