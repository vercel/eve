---
"eve": patch
---

A hook's `ctx.cancel()` now counts only if its handler returns. A handler that calls `ctx.cancel()` and then throws fails the turn, as any throwing handler does, instead of also cancelling it.
