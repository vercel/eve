---
"eve": patch
---

MCP tool calls reuse the connection that earlier steps of the same turn opened, instead of repeating the `initialize` handshake and `tools/list` in every step.
