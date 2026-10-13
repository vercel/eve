---
"eve": minor
---

Slack's `renderers.taskCard` now receives a `TaskCard`, the turn's call rows with the session view, instead of a `TaskCardView`, and the `TaskCardView` task, action, blocker, and status types are removed. Render a call's state and label with `callState` and `callLabel` from `eve/events`.
