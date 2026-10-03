---
"eve": patch
---

`mcpChannel` can now publish the agent's own tools next to the `agent_*` tools. Set `tools: true` to list every tool the agent can run outside a conversation, with its JSON schemas, and run each `tools/call` as the route-authenticated caller. Set `agent: false` to stop serving the `agent_*` tools. Both default to what the channel served before, so existing channels do not change.
