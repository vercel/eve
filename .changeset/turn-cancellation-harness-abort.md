---
"eve": patch
---

The turn harness now propagates a cooperative `AbortSignal` end to end: model calls, retries, recovery, compaction, and tool executions all honor it, and an aborted turn settles with a canonical `TurnCancelledError` that is never retried or misclassified as a failure. Authored tools receive the signal as `ctx.abortSignal` (and via the AI SDK execute options), and framework tools forward it into sandbox commands, file I/O, `web_fetch`, and MCP/OpenAPI connection calls. This is the lowest layer of turn cancellation — no trigger exists yet, so runtime behavior is unchanged until the cancellation API ships.
