---
"eve": minor
---

`eve dev` now leaves unfinished workflows from previous dev invocations dormant by default. Use `eve dev --resume` for best-effort recovery of retained, compatible local runs; source-watcher rebuilds and worker restarts within the current invocation continue its workflows normally.
