---
"eve": minor
---

`defineDynamic()` in `agent/tools/` can return a `defineWorkflowTool()` held by a top-level `const`, so a workflow tool can be offered only on some model calls.

Its entry point can be written inline or reference a top-level `"use workflow"` function. The build fails when a workflow tool's entry point lacks `"use workflow"` or the tool is created inside the dynamic function.
