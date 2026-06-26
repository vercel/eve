---
"eve": patch
---

Add `session: "stateful"` to `defineMcpClientConnection`. Stateful connections persist their MCP `Mcp-Session-Id` across step boundaries (scoped per principal) so a stateful MCP server treats the whole eve session as one session, re-initializing automatically if the server expires it.
