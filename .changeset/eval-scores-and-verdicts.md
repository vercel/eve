---
"eve": minor
---

Evals can record raw measurements with `t.score(key, evaluation)`, tracked only until a `.gate()` or `.atLeast()` rule is chained. `AssertionResult` now carries a stable `key`, omits `score` when the scorer threw, and omits `threshold` and `passed` when no acceptance rule applies.
