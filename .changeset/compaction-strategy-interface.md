---
"eve": minor
---

An agent can now choose how its history is compacted. Export a strategy from `agent/compaction.ts` with `defineCompaction` from `eve/compaction`; its `compact` returns the replacement history, and eve keeps the events, memory recall, failure handling and billing. A hook can request a compaction with `ctx.compact()`, and `ctx.view.context.inputTokens` reports the latest model call's input tokens. eve still compacts when a request would fill 90% of the context window, and runs the default `fixedTail()` once if a strategy's result is still over it. The default is unchanged. `compaction.thresholdPercent` is removed.
