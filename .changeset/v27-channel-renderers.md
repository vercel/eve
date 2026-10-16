---
"eve": minor
---

Slack's `renderers.taskCard` receives a `TaskCard` containing call rows and the session view instead of `TaskCardView`; its task, action, blocker, and status types are removed, and `callState`/`callLabel` from `eve/events` provide rendering state. Teams channel state replaces `pendingAuthActivityId` with `pendingAuthActivityIds`, one activity per connection.
