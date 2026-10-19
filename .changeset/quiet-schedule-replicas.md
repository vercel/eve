---
"eve": patch
---

`eve start --no-schedules` and `EVE_SCHEDULES_DISABLED=1` start a server that does not fire authored cron schedules, so only one process runs them when you scale out.
