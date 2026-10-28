---
"eve": minor
---

Definitions must come from eve's helpers: export `defineAgent({...})` from every local `agent.ts` (and return it from dynamic subagents), and `defineMcpClientConnection` or `defineOpenAPIConnection` from static connections, because builds now reject plain objects. `DynamicSentinel`, `DisabledToolSentinel`, and `DisabledRouteSentinel` are opaque, so create them only with `defineDynamic()`, `disableTool()`, and `disableRoute()`. Builds also reject `agent/sandbox.ts` beside `agent/sandbox/`; move the definition to `agent/sandbox/sandbox.ts`.
