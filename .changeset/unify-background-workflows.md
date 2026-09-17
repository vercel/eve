---
"eve": minor
---

Require durable background tools to use `defineWorkflowTool`. Remove background execution from `defineTool` and dynamic tools, including the `TaskExec` and `postMessage` authoring APIs, and deliver each background cohort's completed, failed, and cancelled outcomes in one automatic report.

Background invocations now share workflow execution and cancellation cleanup; channel task views no longer include executor bindings.
