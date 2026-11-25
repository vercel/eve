---
title: "Experimental compaction strategies"
description: "Replace how eve compacts the history, and decide when it runs."
---

`experimental.compaction` replaces how eve compacts an agent's history. The API is experimental and can change in any release. It takes the place of the [`compaction`](../agent-config#compaction) block: set both and eve rejects the agent. Pass `model` and `threshold` to `defaultCompaction()` instead.

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

## Decide when it runs

The strategy decides from what `ctx` tells it. `ctx.tokens` is the next request's input tokens, including instructions, tools and recalled memory. `ctx.requested` is `true` only for `session.compact()`, and `ctx.overflow` is `true` only on the retry after a context-overflow error. Compact whatever the size when either is set. Otherwise return `undefined` while `ctx.tokens` is under the budget the strategy chose, and the history as it is when nothing needs to change. A strategy that rewrites on every call rewrites once more after each compaction, and in development and tests eve fails the strategy when it changes what it returned.

Without `experimental.compaction`, a provider rejection fails the turn.

## What a strategy reads

- `ctx.call({ messages, model?, system?, tools?, providerOptions? })` calls a model and returns `{ messages, text }`. eve sends exactly `messages`, with no recalled memory, client context or announcements. `system` defaults to the agent's instructions, `tools` to `"none"`, and `model` to the turn's model. eve bills the call to the compaction. A request longer than the model's context window rejects with `CompactionOverflowError`, which a strategy can catch before it drops part of what it sent and calls again.
- `ctx.requested` and `ctx.overflow` say why eve asks when it isn't an ordinary model call. Both are `false` for an ordinary call, and never both `true`.
- `ctx.recompacting` is `true` when the previous rewrite did not leave room, because the history was due again within one response.
- `ctx.model` is the session model's `provider` and `modelId` as the AI SDK names them, with its `contextWindowTokens` and `maxOutputTokens`.
- `ctx.tokens` is the next request's input tokens, as the provider counted the last request plus eve's estimate of what joined the history since. `ctx.estimate(messages)` is the estimate of a message list in eve's own units, a quarter of its serialized bytes plus media. `ctx.fixedTokens` is what the request holds besides the history, in the same units, and `ctx.estimateRatio` is the measured ratio of the provider's count to the estimate.
- Every user message carries a `kind`: `"user"` for what a person sent, and a framework kind such as `"context.compaction"` for what eve or a strategy added.

## What eve checks

eve checks every result before it applies it, for every strategy. A result fails the compaction, and leaves the history as it was, when it drops a tool call's result or a call, keeps more than one checkpoint, removes a user message's `kind`, or doesn't fit within the model's context window beside the instructions, tools and recall. In development and tests, a strategy that compacts what it already returned fails too. eve never falls back to its default when a strategy fails.

What the model answers next is up to the strategy. Keep the turn's latest user message, or carry it in the summary and add a message, such as an `"execution.continuation"`, that tells the model to go on.

## Built-in strategies

`defaultCompaction({ model?, instructions?, threshold? })` is eve's compaction when you set none. It caps oversized tool results in older history, and summarizes the older history when capping doesn't fit. On an OpenAI model it keeps the messages it keeps exactly as they were and appends the summary after them, so OpenAI keeps their reasoning. `model` writes the summary with another model, `instructions` adds to eve's checkpoint prompt, and `threshold` is the fraction of the window at which it compacts, 0.9 by default. It counts the checkpoint prompt it adds, so it starts before the conversation alone reaches the threshold.

`withoutInjected(history)` removes the messages eve adds to every request (memory, instructions, state and the previous checkpoint) from a history you send. eve adds them again after the compaction.

## Compact with OpenAI's own compaction

`openaiCompaction({ fallback?, threshold? })` compacts with OpenAI's compaction instead of a text summary. eve sends the turn's request with OpenAI's `compaction_trigger`, and OpenAI answers with an encrypted record of the history. eve stores the record as the history and sends it with every later request, so the model keeps its working state where a summary would drop it. `threshold` is the fraction of the window at which it compacts, 0.9 by default.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { openaiCompaction } from "eve/experimental/compaction";
import { openai } from "eve/models/openai";

export default defineAgent({
  model: openai("gpt-5"),
  experimental: { compaction: openaiCompaction({ threshold: 0.8 }) },
});
```

- It works with `openai("gpt-...")` and with an AI Gateway string such as `"openai/gpt-5"`. Through AI Gateway, eve sets `providerOptions.gateway.only` to `["openai"]` on the compaction request and on every later request that holds the record, because another provider can't read it. A `gateway.only` you set in `modelOptions` replaces it on the later requests. On the compaction request it narrows it instead: if your list excludes `openai`, eve doesn't send the history to OpenAI and compacts with the fallback.
- Another model, a failed call, or an answer without a record compacts with `fallback`, which is `defaultCompaction({ threshold })` with the same `threshold` unless you pass another strategy, and eve logs why when the fallback compacts. A strategy you pass decides for itself whether to compact, from its own threshold. A history that already holds a record is the exception: a text summary would drop what the record holds, so eve keeps the history and compacts again on a later request. A session that switches to another model after a compaction logs a warning on each request and sends the history without the record.
- eve leaves out the messages it adds to every request (memory, instructions, state and the previous checkpoint) and adds them again after the compaction, because the record would hold stale copies of them.
- The agent's `store` setting applies to the compaction call and to every later request. When the provider keeps the response, eve refers to the record by id for as long as it is kept. With `modelOptions: { providerOptions: { openai: { store: false } } }`, eve sends the record inline with its encrypted content, so the session stays resumable after the provider's retention.
- On an OpenAI model eve fixes the `tools` array at the session's first request. A tool that appears later, such as a connection added mid-session, is not appended to `tools`, which would make OpenAI drop the reasoning in the history. eve sends it once as a system message with empty content and `providerOptions.openai.additionalTools`, and keeps that message in the history.
- The first two requests after a compaction miss the prompt cache past the instructions and tools: the first has never been seen, and OpenAI doesn't read a prefix that ends on the record from its cache. The third and later requests hit it.
