---
"eve": minor
---

`decide`, both `auto()` helpers, and eval judges now use eve-owned decision types from `eve/ai`. Standalone `decide` takes `signal` instead of `abortSignal` and returns only `answers` and `usage`; AI SDK request hooks, internal options, and provider metadata are no longer public contracts.
