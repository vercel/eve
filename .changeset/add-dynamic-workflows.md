---
"eve": minor
---

Replace the uppercase `Workflow` tool and `experimental_workflow()` helper with the root-only `workflow` tool, enabled by creating `agent/tools/workflow.ts`. Dynamic workflows run model-authored JavaScript that coordinates visible subagents and awaits their final results; import the `workflow` factory from `eve/tools/workflow` to set a per-program `maxSubagents` limit.
