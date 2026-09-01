---
"eve": minor
---

Session creation on eve, MCP, and authored channels now returns as soon as Workflow accepts the run. Concurrent first messages on one channel address are settled inside the workflow, racing `operationId` requests may return different candidate IDs that callers resolve after startup, and Workflow starts target known deployment IDs without resolving a latest-deployment sentinel.
