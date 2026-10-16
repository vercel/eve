---
"eve": minor
---

Hooks and channel handlers receive v27 facts as `(event, ctx)`, with coordinates in `event.scope`, position and session tables in `ctx.position` and `ctx.view`, and channel-specific context in `ctx.channel` instead of `ctx.scope`. Channels can render once per committed line with `committed(line, ctx)`; removed v26 handler keys are rejected, and wildcard hooks no longer receive progress records.
