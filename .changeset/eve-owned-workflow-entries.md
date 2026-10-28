---
"eve": minor
---

Import durable primitives from `eve/workflow` and run/hook operations from `eve/workflow/api` instead of the bare `workflow` and `workflow/api` paths, which now fail in authored modules. New projects no longer need ambient Workflow types; existing `eve/workflow-modules` tsconfig entries can remain through 1.x.
