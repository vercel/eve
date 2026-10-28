---
"eve": minor
---

Builds now reject agent and connection definitions that don't come from eve's helpers.

Export `defineAgent({...})` from every local `agent.ts` (and return it from dynamic subagents), wrap static connections in `defineMcpClientConnection` or `defineOpenAPIConnection` (plain objects no longer default to MCP), and create sentinels only with `defineDynamic()`, `disableTool()`, and `disableRoute()`. Move an `agent/sandbox.ts` that sits beside `agent/sandbox/` to `agent/sandbox/sandbox.ts`.
