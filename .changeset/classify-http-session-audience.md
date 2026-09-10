---
"eve": patch
---

Let `eveChannel` set the tracing audience for each new HTTP session with an asynchronous `audience(ctx)` resolver over the verified caller and request. Attached local TUI sessions set the tracing audience to `private`, while zero-config local tracing retains private trace metadata without capturing model or tool content.
