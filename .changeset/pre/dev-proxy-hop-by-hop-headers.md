---
"eve": patch
---

`eve dev` no longer answers every second request with an empty `400 Bad Request` when the client sends `Connection: close` and the agent replies with a keep-alive response such as an MCP SSE stream, as happens behind the `vercel dev` proxy.
