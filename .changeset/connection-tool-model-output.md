---
"eve": patch
---

Add `toolCall.toModelOutput` to MCP and OpenAPI connections: a per-operation projection of the model-facing tool result, keyed by remote tool or operation name. It reuses the authored-tool `toModelOutput` contract, so `action.result`, channel events, and hooks still receive the complete remote result. Operations without an entry are unchanged.
