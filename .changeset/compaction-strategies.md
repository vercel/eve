---
"eve": patch
---

Set `compaction.compact` in `agent.ts` to rewrite the history your own way when eve compacts, and choose when it runs.

`eve/compaction` exports `fixedTail()`, eve's default strategy, and `turns()`. A strategy summarizes with `ctx.summarize()`, optionally with its own prompt over the turn's cached prefix, and builds the checkpoint head with `ctx.checkpoint()`. Pass `{ compact, when }` to run it before a model call, at the end of a turn, or both, on your own `due()` rule. eve checks every result before it applies it and never falls back to its default.
