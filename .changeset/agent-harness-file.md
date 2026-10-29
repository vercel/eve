---
"eve": patch
---

Add an experimental `agent/harness.ts`. Its `defineHarness((ctx) => ({ agent, history, next }))` can add instructions and tools to each model call, choose the model, replace compaction, and continue a turn with a note before it ends.
