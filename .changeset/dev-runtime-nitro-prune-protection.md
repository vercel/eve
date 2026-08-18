---
"eve": patch
---

Protect dev-runtime snapshots referenced by generated Nitro artifacts from stale snapshot pruning, so `eve dev` routes do not lose boot-time compiled-artifact imports after rebuild churn.
