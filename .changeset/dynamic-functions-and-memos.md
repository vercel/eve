---
"eve": minor
---

Define dynamic capabilities with `defineDynamic(ctx => value)` instead of lifecycle maps, and use ordinary functions and schemas instead of `defineDurableCallback` and `defineDurableSchema`. Cache external JSON observations with `ctx.memo(key, fn)`.
