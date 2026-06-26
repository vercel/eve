---
"eve": patch
---

Add opt-in `session: { mode: "stateful" }` support for MCP connections. Stateful MCP connections persist Streamable HTTP session metadata across eve step boundaries and reattach through the native AI SDK MCP session hooks, retrying with a fresh session when the server expires the saved one.
