---
"eve": patch
---

Session workflow steps that only publish events or update session state, such as a workflow tool's progress report, no longer store the conversation history in their Workflow step input, so their stored size stops growing with the conversation. The session handoff checkpoint changed shape, so an idle session does not move between deployments on either side of this release; its current owner keeps running it.
