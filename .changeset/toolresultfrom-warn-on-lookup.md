---
"eve": patch
---

Connections or tools that share a `toolResultFrom` fallback identity, such as two MCP connections with the same URL and description, no longer log the "could not assign a unique toolResultFrom identity" warning at startup. eve now warns once, only when a `toolResultFrom` lookup actually needs that ambiguous fallback.
