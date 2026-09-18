---
"eve": patch
---

Workflow steps now fail immediately with actionable guidance when they access workflow-body-only `ctx.agents`, `ctx.agent()`, or `ctx.ask()` capabilities. Use the new `WorkflowStepToolContext` type for step helpers and pass serializable agent metadata from the workflow body.
