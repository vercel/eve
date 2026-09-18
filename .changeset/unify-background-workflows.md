---
"eve": minor
---

Require durable background tools to use `defineWorkflowTool`. Remove background execution from `defineTool` and dynamic tools, including the `TaskExec` and `postMessage` authoring APIs, and deliver each background cohort's completed, failed, and cancelled outcomes in one automatic report.

Background invocations share workflow execution and cancellation cleanup. Agent settlement records usage once before its enclosing workflow returns a tool result. Parent sessions retain task outcomes, and late results cannot overwrite a recorded cancellation; channel task views no longer include executor bindings. Background workflow yields are consumed without publishing progress or retaining a task-progress stream.
