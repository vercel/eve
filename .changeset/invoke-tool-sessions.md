---
"eve": patch
---

`invokeTool` now accepts a `key`: calls from the same caller with the same key share one session id and keep their sandbox between calls, on Vercel Sandbox and just-bash. `mcpChannel({ tools: true })` advertises the `dev.eve/tool-sessions` extension, so MCP clients that declare it can join a tool session with `_meta["dev.eve/tool-session"]`. Tool sessions need an authenticated caller: a keyed call from the anonymous principal `none()` gives is denied. A tool session has no end, so an app that uses keyed calls on Vercel Sandbox runs the new `sweepToolSessionSandboxes` from `eve/sandbox` in a schedule to delete tool-session sandboxes unused for 30 days; a deploy that changes the agent's sandbox definition starts a fresh sandbox for each key and leaves the old one to that sweep.
