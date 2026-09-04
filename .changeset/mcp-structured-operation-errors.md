---
"eve": patch
---

MCP tool calls that are rejected now return `structuredContent.error` with a stable `code` (`invalid_input`, `not_found`, `conflict`, `internal`), a short `message`, and `retryable`, so clients can act without parsing text. Unexpected server failures no longer forward their raw message; they return an `errorId` that correlates with eve's logs.
