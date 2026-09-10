---
"eve": patch
---

Adds `experimental.workflow.retention` to `defineAgent`, which forwards a run's data-retention preference to the durable runtime. Set it to `0` to have a run's payloads, streams, and event log deleted as soon as the run finishes instead of kept for the world's default period.
