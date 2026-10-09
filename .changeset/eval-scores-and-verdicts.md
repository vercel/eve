---
"eve": minor
---

Adds `t.score(evaluation)` for recording a score, named with `.label(key)` and gated with `.gate()` or `.atLeast()`. `AssertionResult` gains `key`, and `score`, `threshold`, and `passed` are now optional: `score` is absent when the scorer threw, and `threshold` and `passed` are absent when no rule applies, so custom reporters should treat `passed === false` as the failure signal. `eve eval` warns when an eval records the same assertion name more than once with different scores.
