---
"eve": minor
---

A dynamic schedule's `preparePayload` receives the schedule's timing as `context.expression`.

It is the timing the caller passed, or the stored timing when an update replaces only the payload, so `preparePayload` can tell a recurring schedule from a one-time one without a payload field for it.
