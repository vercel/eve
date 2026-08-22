---
"eve": patch
---

Prepare workflow execution to run a configurable number of agent loop steps within each durable step. Completed logical steps are journaled for cancellation and Workflow retry recovery, while background task launches and requested sleeps remain batching barriers; the limit stays at one, so ordinary execution behavior is unchanged.
