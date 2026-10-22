---
"eve": patch
---

Self-hosted `eve start` servers now reject requests to `/.well-known/workflow/v1/flow` that did not come from the server's own workflow queue, so a client can no longer forge a workflow delivery with a chosen run context or principal. Startup always recovers pending and running local workflow runs through the authenticated queue, ignoring `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS`; queue deliveries must stay on the process that enqueued them.
