---
"eve": patch
---

Let background task children send intermediate progress to their parent with `task_update`, using the existing local and remote child-to-parent transports. Remote task HITL is now presented only by the parent channel, finished agents continue through their original subagent tool with `agentId`, and the redundant `task_send` tool has been removed.
