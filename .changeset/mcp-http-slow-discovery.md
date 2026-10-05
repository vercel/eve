---
"eve": patch
---

Keep MCP connections over HTTP on the `2026-07-28` protocol when the server is slow to answer `server/discover`. Previously eve gave up after 1 s and fell back to the legacy handshake, which servers that only speak the new protocol reject with `Unsupported protocol version: 2025-11-25`.
