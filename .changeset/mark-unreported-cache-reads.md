---
"eve": minor
---

`usage.recorded` now marks a provider that didn't report cache reads with `cacheReadUnreported: true`, so its `cacheReadTokens` of 0 no longer reads as a cache miss, and an answer whose provider reported no usage records none instead of a free one.

Sessions converted from before v27 follow the same rule. Thanks @zackleman for reporting this in #5919.
