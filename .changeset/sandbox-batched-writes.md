---
"eve": patch
---

Sandbox batch writes no longer run one file at a time on providers without a native batch API: the just-bash and Docker connections now write with a bounded number of writes in flight and reject an already-aborted batch before writing anything. The sandbox docs describe the batch's partial-failure semantics.
