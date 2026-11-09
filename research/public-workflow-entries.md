---
issue: "Maintainer-approved 1.0 API audit; stack #5486"
status: implemented
last_updated: "2026-11-09"
---

# Public Workflow entries

Authors import durable primitives from `eve/workflow` and hook operations
from `eve/workflow/api`. No separately installed `workflow` package or ambient
declaration is needed.

```ts
import { createHook, sleep, FatalError } from "eve/workflow";
import { resumeHook } from "eve/workflow/api";
```

The stable entries carry only what a durable tool needs to wait on time or an
outside event: `createHook`, `createWebhook`, `sleep`, `FatalError`, and
`RetryableError` in `eve/workflow`, and `resumeHook` in `eve/workflow/api`.
eve has no native equivalent for these, and `defineWorkflowTool` bodies depend
on them.

Run operations are experimental: `getWorkflowMetadata` in
`eve/experimental/workflow`, and `start` and `getRun` in
`eve/experimental/workflow/api`. They mostly overlap with `task` and `serve`
tools, and the Workflow SDK's run and stream model is still moving (for
example, toward streams not owned by a run), so eve does not pin them for 1.x.
Promoting them later is additive; moving them out of a stable entry would need
a major. Importing a moved export from its old entry is a build error that
names the new entry.

Run streams are experimental too: `getWritable({ namespace })` in
`eve/experimental/workflow` and `getReadable(runId, { namespace, startIndex })`
in `eve/experimental/workflow/api`. They let one run publish state that a
route, step, or another run reads, which no stable eve surface covers. Both
require a namespace and reject `eve.` and `eve:` prefixes, because a run's
default stream holds eve's session records and eve's own streams use those
prefixes. The check runs in the step and server entry and in a body-side shim
the driver resolves the entry to, so bodies get the same rule. `getReadable` is
a function rather than a `WorkflowRun` method so `start` and `getRun` keep
returning the SDK's run handle unwrapped. `getHookByToken` stays removed.

Both API entries are unavailable inside replayed workflow bodies: call them
from a route or a `"use step"` function instead.

All four entries declare eve-owned types (`WorkflowHook`, `WorkflowWebhook`, `WorkflowMetadata`,
`WorkflowRun`, and their options) over the SDK values, so SDK-only surface stays private: no
`world`, `deploymentId`, queue namespace, source-string, or encryption options on `start` and
`resumeHook`, no storage-record `getHookByToken`, and a `WorkflowRun` limited to `runId`, `status`,
`returnValue`, and `cancel()`. Type tests assert the SDK values satisfy the eve declarations.

Every entry binds to eve's existing vendored SDK. The driver maps body imports
to its existing Workflow-safe shim; server and step imports share the existing
runtime facade. Do not introduce another SDK or runtime identity.

Authored bare `workflow` and `workflow/*` imports fail with an error naming the
new entries. Generated builder imports keep their historical aliases. New
scaffolds omit `eve/workflow-modules`; the old entry remains an empty declaration
through 1.x so existing tsconfig `types` and reference directives keep resolving.
Removing it is a 2.0 change. There is no bare-import fallback.
