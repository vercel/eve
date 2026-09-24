---
"eve": patch
---

`mcpCapabilitiesChannel` now lists each declared local subagent as a tool. Calling it runs the subagent to completion as the caller, relays its questions and sign-ins as MCP input-required results, and cancels it with a clear error after 150 seconds.
