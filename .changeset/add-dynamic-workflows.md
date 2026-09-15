---
"eve": minor
---

Add `runWorkflowProgram` for executing a runtime-supplied JavaScript function body inside an authored workflow tool through allowlisted `ctx.agent` calls. Remove the experimental `Workflow` framework tool and `experimental_workflow`; migrate its tool file to `defineWorkflowTool` with `runWorkflowProgram`.
