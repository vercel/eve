---
"eve": patch
---

eve has an experimental, internal World host, where sessions of agents defined in code run only when something arrives for them.

The World keeps each session and its queue wakes it; whichever process receives the wake runs it until it waits again, then stops it. Messages and approvals are kept on the World before the wake, timers arm delayed wakes, a delivery near its deadline hands off at a step boundary, and schedules fire once per occurrence across processes. Runs on Workflow's local, Postgres and Vercel Worlds, with no eve build.
