---
"eve": patch
---

Remove unused nested agent invocation tracing. Sessions opened with `ctx.agent` still link to the calling tool's `agent.action` span, and their usage counts toward the parent session's totals.
