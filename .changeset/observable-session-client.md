---
"eve": minor
---

Frontend snapshots expose `view`, `previews`, `messages`, and `agents` directly, with `idle | busy | resuming` status and separate errors; all lifecycle callbacks remain. Tool parts use the shared call `state`, optimistic answers last only through POST acknowledgement, and Stop still targets the observed or pending submission’s turn without withdrawing queued messages.
