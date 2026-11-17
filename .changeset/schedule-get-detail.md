---
"eve": minor
---

A dynamic schedule client's `get` now returns the schedule's `creator` and stored `payload`, so a `scope` resolver or tool can check who a schedule runs as and what it runs before acting on it.

`ScheduleProvider.get` now returns the record with the `envelope` from the stored payload; `list` still returns records without it. The Vercel provider reads the payload with `include=payload` on the Schedules API's single-schedule `GET`.
