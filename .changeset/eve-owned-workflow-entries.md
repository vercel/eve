---
"eve": minor
---

Import durable primitives from `eve/workflow` and run/hook operations from `eve/workflow/api` instead of bare `workflow` paths, which now fail in authored modules; only the documented exports are supported, not the SDK's other subpaths and helpers. New projects no longer need ambient Workflow types; existing `eve/workflow-modules` tsconfig entries can remain through 1.x.
