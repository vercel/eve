---
"eve": minor
---

Hooks and channel handlers now receive v27 facts with coordinates in `event.scope` and session state in `ctx.view`. Update channel handlers to `(event, ctx)` with `ctx.channel`, and migrate instrumentation providers to `InstrumentationEvent<K>` and the new lifecycle names.
