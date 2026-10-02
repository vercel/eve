---
"eve": patch
---

`invokeTool` now accepts a `key`: calls from the same caller with the same key share one session id and keep their sandbox between calls, on Vercel Sandbox and just-bash. `mcpChannel({ tools: true })` advertises the `dev.eve/tool-sessions` extension, so MCP clients that declare it can join a tool session with `_meta["dev.eve/tool-session"]`. Production builds on Vercel Sandbox delete tool-session sandboxes unused for 30 days.
