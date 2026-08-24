---
"eve": patch
---

Run up to ten agent loop steps within each durable Workflow step. Completed logical steps are journaled for cancellation and Workflow retry recovery, while background task launches and requested sleeps remain batching barriers.
