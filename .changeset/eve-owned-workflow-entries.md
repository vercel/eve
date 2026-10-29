---
"eve": minor
---

Import durable primitives from `eve/workflow` and run/hook operations from `eve/workflow/api`, because bare `workflow` imports now fail in authored modules.

Both entries declare eve-owned types: `start(workflow, args?)` takes no options, runs expose only `runId`, `status`, `returnValue`, and `cancel()`, and `getHookByToken` is removed, so pass a deterministic `token` to `createHook` and call `resumeHook(token, payload)`. Ambient Workflow types are no longer needed, though existing `eve/workflow-modules` tsconfig entries can stay through 1.x.
