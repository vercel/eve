---
"eve": patch
"@vercel/agent-runs": patch
---

Update eve's bundled dependencies, including the AI SDK, Vercel SDKs, Chat SDK, MCP, and OpenTelemetry, to their latest releases.

MCP connections over Streamable HTTP now fail when the `server/discover` request fails at the transport level, instead of retrying with `initialize`. Servers that answer `server/discover` with a JSON-RPC error or an HTTP 4xx still use `initialize`, and servers that reject the protocol version with a supported legacy version still negotiate it.
