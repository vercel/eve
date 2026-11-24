---
"eve": minor
---

Set `experimental.compaction` in `agent.ts` to replace how eve compacts the history.

The API is experimental and can change in any release.

`eve/experimental/compaction` exports `defaultCompaction()`, eve's own compaction, and `withoutInjected()`. A strategy is one function that eve asks before every model call, and when a client calls `session.compact()`. It reads `ctx.tokens`, `ctx.requested` and `ctx.overflow`, decides whether the history is due, and returns the history to keep, or `undefined` to keep it. It can rewrite the history with `ctx.call()` model calls. `defaultCompaction()` takes `threshold`, the fraction of the context window at which it compacts. With `experimental.compaction` set, a request the provider rejects as too long compacts and retries once, and `compaction` is an error: pass `model` and `threshold` to `defaultCompaction()`.
