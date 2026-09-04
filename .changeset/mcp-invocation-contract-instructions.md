---
"eve": patch
---

The MCP channel now returns server `instructions` from `initialize` and `server/discover` that summarize the durable invocation protocol, and its tool descriptions state polling cadence, complete-batch input answers, cooperative cancellation, and that `agent_start` is not idempotent. Hosted MCP clients no longer have to infer the lifecycle from the tool schemas.
