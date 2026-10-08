---
"eve": patch
---

Dynamic schedules now use Vercel's local scheduler and queue delivery when eve runs under `vc dev`, so cron and one-time occurrences fire automatically during development. Standalone `eve dev` keeps its in-memory scheduling backend.
