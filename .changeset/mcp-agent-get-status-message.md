---
"eve": patch
---

The MCP channel's `agent_get` now returns an optional `statusMessage` while an invocation is `working`. It names the tool call that is running, using the tool's activity label when it has one, so MCP clients can show progress instead of a bare `working`.
