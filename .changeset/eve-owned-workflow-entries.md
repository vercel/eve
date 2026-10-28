---
"eve": minor
---

Import durable primitives from `eve/workflow` and run/hook operations from `eve/workflow/api` instead of bare `workflow` paths, which now fail in authored modules; ambient Workflow types are no longer needed, though existing `eve/workflow-modules` tsconfig entries can remain through 1.x. Both entries declare eve-owned types: `start(workflow, args?)` takes no options, runs are `WorkflowRun`s with only `runId`, `status`, `returnValue`, and `cancel()`, and `getHookByToken` is removed, so pass a deterministic `token` to `createHook` and resume it with `resumeHook(token, payload)`.
