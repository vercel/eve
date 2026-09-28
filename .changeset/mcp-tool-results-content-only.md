---
"eve": patch
---

Tools discovered through `connection_search` on MCP connections now send the model only the result's `content` blocks. The model used to receive the whole `CallToolResult` as JSON: `_meta`, `isError`, the text JSON-escaped, and the same data again as `structuredContent`. That envelope stayed in history and was re-sent every step. `structuredContent` is still used when `content` is empty, and channels still receive the full result on `action.result`.
