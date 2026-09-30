---
"eve": minor
---

Connection tools no longer break the prompt cache. The model finds them with `connection_search` and calls them with the new `connection_execute` tool, so discovered tools are no longer added to the model's tool list. Connection names now arrive in append-only context messages instead of the system prompt. `connection_execute` returns MCP `structuredContent` or text instead of the raw MCP envelope, and stream events report each call as a nested `<connection>__<tool>` action with a new `parentCallId`. The `eve/tools/connection_search` export is removed, and both tools are reserved names that cannot be replaced or disabled.
