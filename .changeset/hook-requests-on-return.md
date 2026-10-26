---
"eve": patch
---

An unhandled hook error now fails the running turn instead of only being logged. Cancellation requested with `ctx.cancel()` takes effect only if the handler returns successfully.
