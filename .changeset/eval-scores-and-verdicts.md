---
"eve": minor
---

Adds `t.score(evaluation)` for recording a score from 0 to 1, named with `.label(key)` and gated with `.gate()` or `.atLeast()`. `AssertionResult` gains `key`, and `score`, `threshold`, and `passed` are now optional: `score` is absent when the scorer threw, and `threshold` and `passed` are absent when no rule applies, so custom reporters should treat `passed === false` as the failure signal. `eve eval` warns when soft assertions in one eval share a name with different scores.
