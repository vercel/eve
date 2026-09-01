---
"eve": minor
---

Session creation on eve, MCP, and authored channels now returns as soon as Workflow accepts the run. Concurrent first messages on one channel address are settled inside the workflow, and racing `operationId` requests may return different candidate IDs; retry or resolve after startup for the canonical owner.
