---
"eve": minor
---

Evals can record a raw score with `t.score(key, evaluation)`. On its own the score never passes or fails the eval; chain `.gate(threshold)` to fail below the threshold, or `.atLeast(threshold)` to mark the eval `scored`. `AssertionResult` now carries a stable `key`, omits `score` when the scorer threw, and omits `threshold` and `passed` when no acceptance rule applies. `eve eval` warns under an eval that records the same assertion name more than once with different scores, since reporters keep only the lowest score for a shared name; add `.label()` to tell repeated assertions apart.
