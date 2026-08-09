---
"eve": patch
---

Messages no longer wait behind pending tool approvals: a follow-up message now runs as an ordinary turn while the approval stays open and answerable, and a later structured answer still resolves the original tool call. Pending HITL batches are stored as an ordered collection, so a turn that runs while an approval is open can raise its own requests without overwriting it. Sessions wedged by the old deferral release the held message on their next delivery.
