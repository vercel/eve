---
"eve": patch
---

Set `compaction.compact` in `agent.ts` to rewrite the history your own way when eve compacts, and choose when it runs.

`eve/compaction` exports `fixedTail()`, eve's default strategy, and `turns()`. A strategy summarizes with `ctx.summarize()`, optionally with its own prompt over the turn's cached prefix, and builds the checkpoint head with `ctx.checkpoint()`. Pass `{ compact, when }` to run it before a model call, at the end of a turn, or both, on your own `due()` rule. eve checks every result before it applies it and never falls back to its default.

A model call the provider rejects as too long now compacts with reason `overflow` and retries once, and `ctx.summarize()` rejects with `CompactionOverflowError` when the summary request is too long.

History messages are typed `StoredHistoryMessage`, with `kind` on every user message (`HistoryMessageKind`). A strategy can place its summary anywhere as a `context.compaction` message, send its summary request with its own `system`, and read `ctx.model` and `measure.maxOutputTokens`. An automatic result no longer has to keep the turn's latest user message.
