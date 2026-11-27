---
title: "Experimental compaction strategies"
description: "Replace how eve compacts the history, and decide when it runs."
---

`experimental: { compaction }` on `defineAgent` replaces how eve compacts the agent's history. The API is experimental and can change in any release. An agent with a strategy takes the place of its [`compaction`](../agent-config#compaction) block: set both and eve rejects the agent. Pass `model` and `threshold` to `defaultCompaction()` instead.

A dynamic model can set it too. A `ModelSelection` that a [`defineDynamic`](../guides/decide) callback returns takes `experimental: { compaction }` beside `modelOptions` and `reasoning`, and replaces the agent's strategy for the turns that selection serves.

A strategy is one function that decides whether the history is due and, if it is, rewrites it. eve asks it before every model call, including a retry, and when a client calls `session.compact()`. When the provider rejects a request as longer than the model's context window, eve asks again with `ctx.overflow` set and retries the call once. The strategy receives the stored history and returns the history to keep, or `undefined` to keep it as it is.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { type CompactionStrategy } from "eve/experimental/compaction";

/** Summarizes every turn before the latest user message, which it keeps word for word, at 80% of the window. */
const keepLatestTurn: CompactionStrategy = async (history, ctx) => {
  const window = ctx.model.contextWindowTokens;
  if (!ctx.requested && !ctx.overflow && (window === undefined || ctx.tokens < 0.8 * window)) {
    return undefined;
  }
  const latest = history.findLastIndex((m) => m.role === "user" && m.kind === "user");
  const { text } = await ctx.call({
    messages: [
      ...history.slice(0, latest),
      { role: "user", kind: "context.compaction", content: "Summarize the conversation above." },
    ],
    system: "Keep every ticket ID exactly as written.",
  });
  return [
    { role: "user", kind: "context.compaction", content: "Summary of our conversation so far:" },
    { role: "assistant", content: text },
    ...history.slice(latest),
  ];
};

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  experimental: { compaction: keepLatestTurn },
});
```

## Fall back when a strategy fails

`compaction` also takes `{ strategy, fallback }`. When `strategy` fails, eve compacts with `fallback` instead, and logs why the strategy failed. `fallback` is `defaultCompaction()` unless you pass another strategy.

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  experimental: { compaction: { strategy: keepLatestTurn, fallback: defaultCompaction() } },
});
```

eve runs the fallback when the strategy throws, when its result fails the checks in [What eve checks](#what-eve-checks), and when it keeps the history as it is after the provider rejected a request as too long. The fallback decides for itself whether to compact, like any strategy. When it also keeps the history, a compaction that was requested fails with the strategy's error, and a provider rejection fails the turn. On an ordinary turn the compaction is recorded as failed and the turn goes on with the history as it is, so a strategy that fails at 70% of the window doesn't end a turn when the fallback, `defaultCompaction()`, doesn't compact until 90%.

Some failures never run the fallback, because a second attempt would not help or would hide the cause: a cancelled turn, a session whose output stream is closed, and an agent that sets both a strategy and `compaction`.

## Decide when it runs

The strategy decides from what `ctx` tells it. `ctx.tokens` is the next request's input tokens, including instructions, tools and recalled memory. `ctx.requested` is `true` only for `session.compact()`, and `ctx.overflow` is `true` only on the retry after a context-overflow error. Compact whatever the size when either is set. Otherwise return `undefined` while `ctx.tokens` is under the budget the strategy chose, and the history as it is when nothing needs to change. A strategy that rewrites on every call rewrites once more after each compaction, and in development and tests eve fails the strategy when it changes what it returned.

Without a strategy on the agent, a provider rejection fails the turn.

## What a strategy reads

- `ctx.call({ messages, model?, system?, tools?, providerOptions? })` calls a model and returns `{ messages, text }`. eve sends exactly `messages`, with no recalled memory, client context or announcements. `system` defaults to the agent's instructions, `tools` to `"none"`, and `model` to the turn's model. eve bills the call to the compaction. A request longer than the model's context window rejects with `CompactionOverflowError`, which a strategy can catch before it drops part of what it sent and calls again.
- `ctx.requested` and `ctx.overflow` say why eve asks when it isn't an ordinary model call. Both are `false` for an ordinary call, and never both `true`.
- `ctx.recompacting` is `true` when the previous rewrite did not leave room, because the history was due again within one response.
- `ctx.model` is the session model's `provider` and `modelId` as the AI SDK names them, with its `contextWindowTokens` and `maxOutputTokens`.
- `ctx.tokens` is the next request's input tokens, as the provider counted the last request plus eve's estimate of what joined the history since. `ctx.estimate(messages)` is the estimate of a message list in eve's own units, a quarter of its serialized bytes plus media. `ctx.fixedTokens` is what the request holds besides the history, in the same units, and `ctx.estimateRatio` is the measured ratio of the provider's count to the estimate.
- Every user message carries a `kind`: `"user"` for what a person sent, and a framework kind such as `"context.compaction"` for what eve or a strategy added.

## What eve checks

eve checks every result before it applies it, for every strategy. A result fails the compaction, and leaves the history as it was, when it drops a tool call's result or a call, puts a checkpoint after other messages, removes a user message's `kind`, or doesn't fit within the model's context window beside the instructions, tools and recall. In development and tests, a strategy that compacts what it already returned fails too. A failed strategy compacts with the [fallback](#fall-back-when-a-strategy-fails), and a failure of both leaves the history as it was.

What the model answers next is up to the strategy. Keep the turn's latest user message, or carry it in the summary and add a message, such as an `"execution.continuation"`, that tells the model to go on.

## Built-in strategies

`defaultCompaction({ model?, instructions?, threshold? })` is eve's compaction when you set none. It caps oversized tool results in older history, and summarizes the older history when capping doesn't fit. `model` writes the summary with another model, `instructions` adds to eve's checkpoint prompt, and `threshold` is the fraction of the window at which it compacts, 0.9 by default. It counts the checkpoint prompt it adds, so it starts before the conversation alone reaches the threshold.

`withoutInjected(history)` removes the messages eve adds to every request (memory, instructions, state and the previous checkpoint) from a history you send. eve adds them again after the compaction.
