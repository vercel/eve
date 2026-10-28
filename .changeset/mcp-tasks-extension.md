---
"eve": minor
---

The MCP channel supports the MCP Tasks extension. Clients that declare `io.modelcontextprotocol/tasks` get a task from `agent_start` and can follow it with `tasks/get` and `subscriptions/listen`, where a working task's `statusMessage` names the calls the agent is running.
