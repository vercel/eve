---
"eve": minor
---

Add a `fetch` option to `defineMcpClientConnection`, so every HTTP request eve sends to an MCP server can go through your function.

Use it to adapt a server that strays from the protocol, route through a proxy, or record traffic.
