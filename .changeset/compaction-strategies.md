---
"eve": patch
---

Set `compaction.compact` in `agent.ts` to rewrite the history your own way when eve compacts.

`eve/compaction` exports `fixedTail()`, eve's default strategy, and `turns()`. A strategy summarizes with `ctx.summarize()` and builds the checkpoint head with `ctx.checkpoint()`. eve checks every result before it applies it and never falls back to its default.
