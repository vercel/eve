---
"eve": patch
---

Dynamic schedules now use Vercel's local scheduler and queue delivery under `vc dev`, so cron and one-time occurrences fire automatically. The local consumer loads only for Vercel-backed dynamic collections; standalone `eve dev` keeps its in-memory scheduling backend.
