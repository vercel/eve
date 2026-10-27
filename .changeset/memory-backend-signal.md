---
"eve": minor
---

Memory document backend `read()` and `write()` inputs use `signal` again, restoring the pre-0.84.0 contract. Only backends and direct calls using the `abortSignal` input from `0.84.x` need updating; memory and tool execution contexts still expose `ctx.abortSignal`.
