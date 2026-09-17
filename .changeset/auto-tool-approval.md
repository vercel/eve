---
"eve": patch
---

Add `auto({ model?, instructions?, criteria? })` for evaluation-model tool approvals, defaulting to TypeSafe Jev and failing closed to user approval. Approval policies now receive the active turn's cancellation signal.
