---
"eve": minor
---

Replace the uppercase `Workflow` tool and `experimental_workflow()` helper with the experimental, root-only `workflow` tool, enabled through `experimental.dynamicWorkflows`. Dynamic workflows run model-authored JavaScript that coordinates visible subagents, awaits their final results, and enforces an optional per-program `maxSubagents` limit.
