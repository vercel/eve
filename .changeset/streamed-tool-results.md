---
"eve": patch
---

Tools can now use async generators to stream preliminary output snapshots. eve publishes local snapshots as `action.partial` events before the final `action.result`, and the default client reducer exposes provisional output with `partial: true`.
