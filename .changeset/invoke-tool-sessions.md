---
"eve": patch
---

`invokeTool` now accepts a `key`: calls from the same caller with the same key share one session id and keep their sandbox between calls, on Vercel Sandbox and just-bash. `mcpChannel({ tools: true })` advertises the `dev.eve/tool-sessions` extension, so MCP clients that declare it can join a tool session with `_meta["dev.eve/tool-session"]`. Tool sessions need an authenticated caller: a keyed call from the anonymous principal `none()` gives is denied. Every production build whose agent uses Vercel Sandbox registers a weekly `eve.tool-session-sandbox-sweep` cron task that deletes tool-session sandboxes unused for 30 days, whether or not the app uses keyed calls; a deploy that changes the agent's sandbox definition starts a fresh sandbox for each key and leaves the old one to the sweep.
