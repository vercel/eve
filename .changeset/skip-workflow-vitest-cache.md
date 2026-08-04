---
"eve": patch
---

Dev runtime snapshots no longer copy the `.workflow-vitest` test cache. In
workspaces that had run integration tests, this directory was duplicated into
every generation under `.eve/dev-runtime/snapshots` — tens of megabytes per
rebuild that nothing at dev runtime reads.
