---
"eve": patch
---

MCP tools found through `connection_search` now pass the model only their result's `content`, not the full MCP result with its duplicated `structuredContent`, so history grows about half as fast on MCP-heavy sessions.
