---
"eve": minor
---

An agent can now choose how its history is compacted. Export a strategy from `agent/compaction.ts` with `defineCompaction` from `eve/compaction`: `shouldCompact` decides when, `compact` returns the replacement history, and eve keeps the events, memory recall, failure handling and billing. The default is unchanged and is available as `fixedTail()`.
