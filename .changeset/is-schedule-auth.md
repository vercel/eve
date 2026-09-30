---
"eve": patch
---

`eve/schedules` now exports `isScheduleAuth(auth)`, which returns `true` for the app principal that schedules pass as `appAuth`. Use it to tell the agent's own scheduled work from a user's turn without copying eve's internal principal values.
