---
"eve": patch
---

Durable sessions now store each step's state as a reference plus its change instead of a full copy, using Workflow's experimental `workflow/state`, so long conversations no longer store their whole history on every turn.

Set `WORKFLOW_STATE_REFS=0` to keep storing full copies.
