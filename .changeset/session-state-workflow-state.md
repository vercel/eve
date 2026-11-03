---
"eve": patch
---

With `WORKFLOW_STATE_REFS=1`, durable sessions store each step's state as a reference plus its change instead of a full copy, using Workflow's experimental `workflow/state`.
