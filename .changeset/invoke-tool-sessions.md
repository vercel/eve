---
"eve": patch
---

`invokeTool` now accepts a `key`: calls from the same caller with the same key share one session id and keep their sandbox between calls, on Vercel Sandbox and just-bash. `mcpChannel({ tools: true })` advertises the `dev.eve/tool-sessions` extension, so MCP clients that declare it can join a tool session with `_meta["dev.eve/tool-session"]`. A forwarded caller's session also covers the verified forwarder, passed as `invokeTool`'s `forwardedBy` (`mcpChannel` passes the router its `auth` verified), so one user reached through two routers gets two sessions. Tool sessions need an authenticated caller: a keyed call from the anonymous principal `none()` gives is denied. On Vercel Sandbox, a tool session's saved filesystem expires a day after its last use, so the next call with the key starts a fresh sandbox; a deploy that changes the agent's sandbox definition also starts a fresh sandbox for each key.
