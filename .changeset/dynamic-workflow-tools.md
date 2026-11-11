---
"eve": minor
---

`defineDynamic()` in `agent/tools/` can return a `defineWorkflowTool()` whose entry point is a top-level `"use workflow"` function, so a workflow tool can be offered only on some model calls.
