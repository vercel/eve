---
"eve": minor
---

A dynamic schedule client's `get` now returns the schedule's `creator` and stored `payload`, so an agent can read a payload, edit it, and write it back with `update`.

The `ScheduleProvider` contract changed: `get(context, name, { payload: true })` must also return the stored `payload` exactly as eve supplied it. Custom providers need to implement this option.
