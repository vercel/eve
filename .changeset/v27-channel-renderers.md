---
"eve": minor
---

Slack's `renderers.taskCard` now receives `TaskCard` instead of `TaskCardView`; use `callState` and `callLabel` from `eve/events` for call rendering. Teams channel state replaces `pendingAuthActivityId` with `pendingAuthActivityIds`.
