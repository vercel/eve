---
title: "Compaction strategies"
description: "Replace how an agent shortens its history by exporting a strategy from compaction.ts."
---

By default eve compacts with the fixed-tail strategy: a summary of everything but the latest conversation, which stays word for word up to 20,000 tokens. See [Default harness](./default-harness). To compact differently, export a strategy from `agent/compaction.ts`.

```ts title="agent/compaction.ts"
import { defineCompaction } from "eve/compaction";

export default defineCompaction({
  async compact(history) {
    return history.slice(-6);
  },
});
```

## When it runs

eve compacts in two cases, and a strategy decides only how:

- **Overflow guard.** A request that would fill 90% of the model's context window is compacted before the model call. This is fixed.
- **A hook asks.** A [hook](../guides/hooks) calls `ctx.compact()` and the next model call compacts first: the running turn's next call, or the first call of the next turn when no turn is running. Asking twice before it runs compacts once.

```ts title="agent/hooks/trim.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    "model.settled"(_event, ctx) {
      if ((ctx.view.context.inputTokens ?? 0) > 60_000) ctx.compact();
    },
  },
});
```

`ctx.view.context.inputTokens` is the input tokens of the latest settled model call.

If a strategy's result is still over the guard, or drops a tool call or result, the compaction fails: a requested one leaves the history as it was and the turn goes on, and one the guard forced ends the session with `COMPACTION_FAILED`.

## What eve does and what the strategy does

eve measures the next request and owns everything around the strategy: the `context.started` and `context.settled` events, [memory](../memory) capture and recall, failure, and billing of the summary call. The strategy owns one decision.

| Member                  | Decides                              |
| ----------------------- | ------------------------------------ |
| `compact(history, ctx)` | The messages that replace `history`. |

`ctx` carries `inputTokens`, `requestEnvelopeTokens`, `threshold`, `recentWindowSize`, and `forced`, which is `true` when a user or a hook asked and the request was not over the limit. `history` is the conversation without memory records; eve places recalled memory ahead of the result, so a strategy never sees or reorders it. A user message you return needs a `kind`; build one with `createCompactionUserMessage(content)` from `eve/compaction`, for example to mark a checkpoint.

`ctx` adds `summarize({ messages, system })`, which runs the compaction model and bills the session, `estimateTokens(messages)`, and, when the turn can be cancelled, an `abortSignal`. A strategy that never summarizes makes no model call.

## Failure

Throw `CompactionOverLimitError` (exported from `eve/compaction`) when no history the strategy could return fits. Any thrown error fails the compaction the way a failed summary does.

## Reusing the default

`fixedTail()` from `eve/compaction` returns the default strategy, so a strategy can wrap it, for example to compact earlier than the threshold. Its options:

- `model`: the model that writes the summary, a gateway model id or a language model. The session's model is the default.
- `recentTokens`: how many tokens of the latest conversation stay word for word. 20,000 by default, and at most half the compaction limit.

For example:

```ts title="agent/compaction.ts"
import { fixedTail } from "eve/compaction";

export default fixedTail({ model: "anthropic/claude-haiku-4.5" });
```
