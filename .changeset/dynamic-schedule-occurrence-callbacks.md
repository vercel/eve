---
"eve": minor
---

Dynamic schedules' `auth` and `run` callbacks receive a `schedule` handle that disables or deletes the schedule that fired, and `auth` can return only `{ attributes }` to run as the stored creator.

An `auth` that returns `null` now fails the occurrence permanently: on Vercel the occurrence is acknowledged without redelivery and `occurrence.failed` fires once, instead of after ten deliveries. The same applies when `auth` returns a principal other than the creator or a value of another shape. An error that `auth` throws is still retried. If your `auth` turns a failed lookup into `null`, make it throw instead, or an outage will fail occurrences without a retry.

The handle and the `auth` result are exported as `ScheduleHandle` and `ScheduleAuthResult`.
