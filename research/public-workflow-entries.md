---
issue: "Maintainer-approved 1.0 API audit; stack #5486"
status: implemented
last_updated: "2026-10-29"
---

# Public Workflow entries

Authors import durable primitives from `eve/workflow` and run/hook operations
from `eve/workflow/api`. No separately installed `workflow` package or ambient
declaration is needed.

```ts
import { createHook, sleep, FatalError } from "eve/workflow";
import { resumeHook } from "eve/workflow/api";
```

The first entry exposes `createHook`, `createWebhook`, `sleep`, `FatalError`,
`RetryableError`, and `getWorkflowMetadata`. The API entry exposes `start`, `getRun`, and
`resumeHook`. The API entry is unavailable inside replayed workflow bodies:
call it from a route or a `"use step"` function instead.

Both entries declare eve-owned types (`WorkflowHook`, `WorkflowWebhook`, `WorkflowMetadata`,
`WorkflowRun`, and their options) over the SDK values, so SDK-only surface stays private: no
`world`, `deploymentId`, queue namespace, source-string, or encryption options on `start` and
`resumeHook`, no storage-record `getHookByToken`, and a `WorkflowRun` limited to `runId`, `status`,
`returnValue`, and `cancel()`. Type tests assert the SDK values satisfy the eve declarations.

Both entries bind to eve's existing vendored SDK. The driver maps body imports
to its existing Workflow-safe shim; server and step imports share the existing
runtime facade. Do not introduce another SDK or runtime identity.

Authored bare `workflow` and `workflow/*` imports fail with an error naming the
new entries. Generated builder imports keep their historical aliases. New
scaffolds omit `eve/workflow-modules`; the old entry remains an empty declaration
through 1.x so existing tsconfig `types` and reference directives keep resolving.
Removing it is a 2.0 change. There is no bare-import fallback.
