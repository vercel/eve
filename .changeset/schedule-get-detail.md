---
"eve": minor
---

A dynamic schedule client's `get(name, { payload: true })` returns the schedule's `creator` and stored `payload`, so an agent can read a payload, edit it, and write it back with `update`.

`get(name)` still returns only the record. The `ScheduleProvider` contract changed: `get(context, name, { payload: true })` must also return the stored `payload` exactly as eve supplied it, so custom providers need to implement this option. With the Vercel provider, `{ payload: true }` requires a Schedules API that supports `GET /v1/schedules/:name?include=payload`.
