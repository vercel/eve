---
"eve": minor
---

Define durable tools with `defineWorkflowTool` from `eve/tools`; its inline or referenced executor must start with `"use workflow"` and receives `ctx.agent` and `ctx.ask`. Replace workflow-backed `defineTool` calls with this API and remove imports from the deleted `eve/workflow` entry point.
