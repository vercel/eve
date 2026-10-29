---
"eve": patch
---

Protect Postgres Workflow execution routes by accepting queue deliveries only through the server's in-process worker.

Use `@workflow/world-postgres` 5.0.5 or later and rebuild the agent. Network requests to the queue handler now return HTTP 401 without executing work. Replicas continue sharing the database queue without a shared delivery secret; channel authentication and public callbacks are unchanged.
