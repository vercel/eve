---
"eve": patch
---

Fire dynamic schedules under standalone `eve dev` instead of leaving them in process memory with no clock until `invoke` was called.

Schedules created while `eve dev` runs without local Vercel Schedules now persist in `.eve/schedules.db` and fire on their own when due, including after the dev server restarts.
