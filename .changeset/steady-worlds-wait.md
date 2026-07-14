---
"eve": patch
---

Keep active local Workflow turns on the development generation they selected across reloads, retries, and server restarts. New turns use the latest successful generation, pruning retains only generations still owned by active work, and `eve dev` now stores local Workflow state under `.eve/workflow-data` (previous top-level `.workflow-data` state is no longer read).
