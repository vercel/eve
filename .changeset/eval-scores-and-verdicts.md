---
"eve": minor
---

Evals can record raw measurements with `t.score(key, evaluation)`, tracked only until a `.gate()` or `.atLeast()` rule is chained. `AssertionResult` now carries a stable `key`, omits `score` when the scorer threw, and omits `threshold` and `passed` when no acceptance rule applies. `eve eval` warns under an eval that records the same assertion name more than once with different scores, since reporters keep only the lowest score for a shared name; add `.label()` to tell repeated assertions apart.
