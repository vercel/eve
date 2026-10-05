---
"eve": patch
---

MCP `tools/call` requests whose arguments don't match the tool's input schema now return `structuredContent.error` with code `invalid_input`, like every other rejected call, instead of only a text message.
