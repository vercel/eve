---
"eve": patch
---

Add per-operation `toolCall.toModelOutput` projections to MCP and OpenAPI connections. Selected operations can return smaller model-facing results while `action.result`, channel events, and hooks retain the full remote response.
