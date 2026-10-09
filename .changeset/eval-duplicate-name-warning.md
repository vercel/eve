---
"eve": patch
---

`eve eval` warns under an eval that records the same assertion name more than once with different scores, since reporters keep only the lowest score for a shared name. Add `.label()` to tell repeated assertions apart.
