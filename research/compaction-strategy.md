---
issue: "None (responds to the compaction strategy proposal in PR #5332)"
status: proposed
last_updated: "2026-10-27"
---

# The compaction strategy

## Summary

A **compaction strategy** is the function that rewrites an agent's stored history when eve
compacts it. eve compacts for exactly two reasons:

- **Overflow:** the next request is larger than the limit `thresholdPercent` sets.
- **Request:** a hook calls `ctx.compact()`, or a client calls `session.compact()`.

Both reasons oblige the strategy to compact. eve validates the result, applies it as a recorded
context change, and bills it.

The `compaction` block takes one of two forms. It either configures eve's default strategy, as it
does today, or supplies a custom one in `compact`. `thresholdPercent` belongs to both, because it
is the limit the kernel enforces, not part of how a strategy compacts.

When to compact beyond size is a hook's job: hooks ask, and any number of them can. Basic
customization stays configuration. Today's `compaction` block is valid unchanged, so nothing
changes before 1.0. The design targets the #4855 session kernel and its `context.*` events.

## Authoring API

### The `compaction` block

```ts
type CompactionDefinition =
  | {
      /** The share of the model's window the context may use. Above it, the context overflows. */
      readonly thresholdPercent?: number;
      /** eve's default strategy: the model that writes its summary, and that model's window. */
      readonly model?: ModelDefinition;
      readonly modelContextWindowTokens?: number;
      readonly compact?: never;
    }
  | {
      readonly thresholdPercent?: number;
      /** A custom strategy. It chooses its own summary model, if it uses one. */
      readonly compact: CompactionStrategy;
      readonly model?: never;
      readonly modelContextWindowTokens?: never;
    };
```

Configure eve's default, as today:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: { thresholdPercent: 0.8, model: "openai/gpt-5-mini" },
});
```

Or bring your own:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { keepBrief } from "../lib/compaction";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: { thresholdPercent: 0.8, compact: keepBrief() },
});
```

A block that sets both `model` and `compact` doesn't type-check. eve also rejects it at load
time, for JavaScript and dynamic values, with: "`compaction.model` configures eve's default
strategy. With `compaction.compact`, choose the summary model in the strategy, for example
`fixedTail({ model })`."

The rule for what sits on the block: a field belongs there only if the kernel needs it to decide
when to call the strategy. `thresholdPercent` qualifies. The summary model doesn't, since only a
strategy that summarizes uses one, and it may want a different model at different times.

### The strategy

```ts
type CompactionStrategy = (
  history: readonly ModelMessage[],
  ctx: CompactionContext,
) => Promise<readonly ModelMessage[] | undefined> | readonly ModelMessage[] | undefined;

interface CompactionContext extends SessionFrame {
  // session, channel, conversation, view, turn, now
  readonly reason: "overflow" | "requested";
  readonly change: { readonly changeId: string };
  readonly tokens: {
    /** eve's measurement of the next request, including instructions, tools, and recall. */
    readonly request: number;
    /** The turn model's context window. */
    readonly window: number;
    /** The most history that fits under the limit, after instructions, tools, and recall. */
    readonly limit: number;
    estimate(messages: readonly ModelMessage[]): number;
  };
  /**
   * Summarizes `messages` with eve's checkpoint prompt, within the summary model's window, billed
   * to the session. `model` defaults to the turn model.
   */
  summarize(
    messages: readonly ModelMessage[],
    options?: { readonly instructions?: string; readonly model?: ModelDefinition },
  ): Promise<string>;
  /** The two-message checkpoint head eve recognizes on the next compaction. */
  checkpoint(text: string): ModelMessage[];
  readonly memo: Memo;
  readonly abortSignal: AbortSignal;
}
```

| Reason      | Caller                                            | The result                     |
| ----------- | ------------------------------------------------- | ------------------------------ |
| `overflow`  | eve, before a model call whose request is too big | must fit within `tokens.limit` |
| `requested` | `ctx.compact()` in a hook, or `session.compact()` | applies at any size            |

`undefined` means there is nothing to remove, and it means that for both reasons. A strategy has
no way to decline, so it can't drop a request or an overflow by mistake. `reason` is a hint about
how hard to compact, not a branch the strategy must handle.

eve exports the building blocks it uses itself:

- `fixedTail(options)`: today's behavior. It caps oversized tool results in older history, with no
  model call, and summarizes the older history only if capping doesn't fit. A request goes
  straight to summarizing. Options: `model` (a model, or a function of the context that returns
  one), `modelContextWindowTokens`, `recentTokens`, and `instructions`.
- `turns(history)`: the history in whole turns, so a strategy that drops or summarizes a range
  never separates a call from its result.

### Hooks ask for a compaction

```ts title="agent/hooks/compact-after-tasks.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    "task.ended"(event, ctx) {
      if (event.data.outcome === "completed") ctx.compact();
    },
  },
});
```

`ctx.compact()` follows `ctx.cancel()`:

- It counts only if the handler returns.
- Repeated requests collapse into one pending compaction.
- During a turn, it applies before the next model call. Between turns, it applies right away.

### The block can be dynamic

```ts title="agent/agent.ts"
import { defineAgent, defineDynamic } from "eve";
import { fixedTail } from "eve/compaction";

export default defineAgent({
  model: defineDynamic((ctx) => pickModel(ctx)),
  compaction: defineDynamic((ctx) => ({
    thresholdPercent: ctx.model.id.startsWith("openai/") ? 0.75 : 0.85,
    compact: fixedTail({ recentTokens: 8_000 }),
  })),
});
```

This is the dynamic `model` pattern. The block is evaluated after the model is chosen, so it can
read `ctx.model.id`.

## Examples

### A cheaper summary model for long sessions

```ts title="agent/agent.ts"
compaction: {
  compact: fixedTail({
    model: (ctx) =>
      ctx.view.usage.total.inputTokens > 5_000_000 ? "openai/gpt-5-mini" : "anthropic/claude-sonnet-5",
  }),
},
```

### A summary prompt for the domain

```ts title="agent/agent.ts"
compaction: {
  thresholdPercent: 0.85,
  compact: fixedTail({
    instructions: [
      "Keep every ticket ID, order number, and refund amount exactly as written.",
      "List each commitment made to the customer and whether it was fulfilled.",
    ].join("\n"),
  }),
},
```

### Keep the original brief

Summaries tend to lose the details of a long task given up front.

```ts title="lib/compaction.ts"
import { fixedTail, type CompactionStrategy } from "eve/compaction";

export const keepBrief =
  (inner: CompactionStrategy = fixedTail()): CompactionStrategy =>
  async (history, ctx) => {
    const [brief, ...rest] = history;
    const compacted = await inner(rest, ctx);
    return compacted && [brief, ...compacted];
  };
```

### Sliding window, no model call

```ts title="lib/compaction.ts"
import { turns, type CompactionStrategy } from "eve/compaction";

export const slidingWindow: CompactionStrategy = (history, ctx) => {
  const kept = turns(history);
  const before = kept.length;
  // Land well under the limit, so the next steps don't overflow again right away.
  while (kept.length > 1 && ctx.tokens.estimate(kept.flat()) > ctx.tokens.limit * 0.5) {
    kept.shift();
  }
  if (kept.length === before) return;
  return [...ctx.checkpoint("Earlier turns were removed to save space."), ...kept.flat()];
};
```

### Archive older history to a store

```ts title="lib/compaction.ts"
import { turns, type CompactionStrategy } from "eve/compaction";
import { archiveStore } from "./archive";

export const archive: CompactionStrategy = async (history, ctx) => {
  const all = turns(history);
  const recent = all.slice(-3).flat();
  const older = all.slice(0, -3).flat();
  if (older.length === 0) return;

  const ref = await ctx.memo(["archive", ctx.change.changeId], ({ idempotencyKey }) =>
    archiveStore.put(ctx.session.id, older, { idempotencyKey }),
  );
  const brief = await ctx.summarize(older, {
    instructions: "Two or three sentences.",
    model: "openai/gpt-5-mini",
  });
  return [
    ...ctx.checkpoint(
      `${brief}\n\nEarlier turns are archived as ${ref}; call recall_archive to read them.`,
    ),
    ...recent,
  ];
};
```

A memo keyed by the change writes to the store once even if the step is retried, provided the
store honors the idempotency key. Memos are a cache: a deployment change discards them, and the key
repeats.

## What eve guarantees

- **The limit.** The limit is the lower of `thresholdPercent` of the window and the window less the
  output reserve. `thresholdPercent: 1` compacts only when a request truly won't fit. eve measures
  each request and calls the strategy with `reason: "overflow"` before calling the provider. This
  check can't be turned off.
- **Validation.** Every call stays paired with its result. Calls the turn waits on are kept. A
  checkpoint, if present, opens the history. An overflow result fits within the limit.
- **The rewrite.** eve owns `context.started` and `context.settled` with `kind: "compaction"`,
  memory capture before the rewrite, billing of `summarize`, and recovery.
- **Loops.** At most one compaction runs per step. Another overflow compaction needs history to
  have grown since the last change. A result equal to its input records no change. Strategies
  should still land well under the limit. `fixedTail()` does, by keeping at most 20,000 recent
  tokens, or half the threshold.

When a strategy gets it wrong:

| Mistake                                                              | eve's response                                                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An overflow result is too large, or `undefined`                      | The step fails before the provider call, naming the strategy and both sizes: "`slidingWindow` returned 142,000 tokens of history; the request allows 118,000." |
| The strategy throws                                                  | The change settles `failed` and history is unchanged. On overflow, the step fails, as today.                                                                   |
| The result separates a call from its result, or drops a pending call | The change fails with a validation error that names the strategy and the call.                                                                                 |

eve doesn't fall back to `fixedTail()` when a strategy fails. A silent fallback would hide a broken
strategy, and the precise error is what lets an author or an agent fix it.

## Why this shape

### A limit and requests

eve already separates bounds from requests elsewhere. `limits.sessionUsage` is a bound the kernel
enforces before model calls, and `ctx.cancel()` is a request any hook can make. Compaction follows
the same split. `thresholdPercent` bounds how much of the window the context may use, and
`ctx.compact()` asks for a compaction now. There is one definition of "too full", and no author
function competes with it.

The cost is staged policies. A strategy can't prune cheaply at 60% and summarize at 90%, because
overflow at 60% obliges it to fit under 60%. Within one call it can still try pruning first and
summarize only if that isn't enough, as `fixedTail()` does. A dynamic `thresholdPercent` covers
"lower the limit after X".

### Requests stack; rewrites have one owner

Each kind of authored code attaches to a point, and the point's rule for combining handlers
decides where the code may be declared:

| Rule          | Combines by                             | Order matters | eve today                                  |
| ------------- | --------------------------------------- | ------------- | ------------------------------------------ |
| **Observe**   | each handler runs independently         | no            | hooks on events                            |
| **Request**   | any request means yes; repeats collapse | no            | `ctx.cancel()`, `session.compact()`        |
| **Restrict**  | the most restrictive answer wins        | no            | approvals, retries (`reactions/policy.ts`) |
| **Transform** | each output is the next one's input     | yes           | the compaction strategy                    |
| **Choose**    | exactly one answer                      | no            | `model`, `compaction`                      |

Handlers whose rule ignores order can be discovered from files and stacked, like hooks and approval
policies. Handlers whose order matters need one owner who composes them explicitly. Asking for a
compaction is a request, so it belongs in hooks. Rewriting history is a transform, so it belongs in
the single `compaction` block, and strategies compose by wrapping each other.

### Hooks don't rewrite history

Hooks run after a commit. A rewrite requested there is stale by the next model call, could not
serve overflow, would let any hook (including one from a third-party extension) edit the
transcript, and would need an ordering mechanism across files. A separate `agent/compaction.ts`
adds a discovered file type for a value that has one owner. Neither is needed.

### Room to grow

The strategy is an interceptor stack of size one: `(history, ctx) => history | undefined`, called
before the model, validated after. If several owners ever need to contribute, `compact` becomes
eve's own entry in such a stack without changing its signature. Many "modify history" needs, such
as redacting secrets for one provider or dropping images for a text-only model, are per-request
views rather than stored rewrites, and would be a separate return shape.

### Built with eve

`fixedTail()` should be an ordinary strategy written only with the public surface above. These
checks hold the design to that:

1. `fixedTail()` lives outside the harness and imports only `eve/compaction`'s public surface. An
   import check like `scripts/extension-capability-contracts.mjs` can enforce it.
2. Compaction and clear share one kernel transition.
3. Memory capture observes compaction through events an author's hook can also observe.
4. The kernel holds no compaction policy beyond the limit: no recent window and no summary prompt.
   It measures, calls the strategy, validates, applies, and records.

## Under the hood: a context change

Compaction is one instance of a transition eve's protocol already names.

| Kind of history mutation | Examples                                                | Owner                           |
| ------------------------ | ------------------------------------------------------- | ------------------------------- |
| **Append**               | inputs, model output, tool results                      | the kernel, every step          |
| **Rewrite**              | compaction, clear, recovery of an interrupted clear     | the kernel, as a context change |
| **View**                 | recalled memory and system instructions in each request | prompt assembly                 |

`context.started` and `context.settled` carry an open `kind`, `selects` describes the change's
effect on the conversation, and usage can be owned by a change (`{ changeId }`). The code doesn't
share a path yet: compaction and clear each end separately in `replaceSessionHistory`.

| Property                         | Compaction                    | Clear                            |
| -------------------------------- | ----------------------------- | -------------------------------- |
| New history                      | the strategy's result         | empty                            |
| `selects`                        | none                          | emptied                          |
| Pending calls in removed history | must be kept                  | their interactions are withdrawn |
| Memory                           | capture before the rewrite    | recall starts over               |
| Where it runs                    | inside a turn or as a control | as a control only                |
| Who asks                         | the limit, a client, a hook   | a client                         |

One internal path can apply both:

1. Commit `context.started`. Reactions keyed on it run, including memory's capture.
2. Run the rewrite: the strategy, or clear's empty history.
3. Withdraw interactions whose call was removed, or reject the result if the kind must keep them.
4. Validate.
5. Replace history and commit `context.settled`, with `selects`, together.

Clear's withdrawals aren't purely derived from removed calls: it also withdraws the session-limit
prompt and keeps requests relayed from running tasks. The shared path has to keep those exactly.
Authored rewrites of other kinds, such as redacting on request, are possible on the same path but
not proposed.

## Compatibility

- Nothing is required before 1.0. Today's `compaction` block is the first form of the union,
  unchanged. `compact` is additive.
- Optional before 1.0: reword the comment on `ContextStartedData.cause` to "What asked for the
  change, such as a control delivery."
- No new event types or fields. A hook's request reports `cause: { hook }`, which the `Cause`
  union already allows. Between turns, it reports no delivery events.
- The one persisted change is a new pending request in the reactions state. It's additive, so
  existing checkpoints still read.
- Readers that assume `context.started.cause` is a delivery need checking before shipping: the
  projection, client reducers, the dev TUI, and the event checker.

## Relationship to #5332

#5332 adds `agent/compaction.ts` with `defineCompaction({ shouldCompact, compact })`. Both designs
agree on most of what surrounds the strategy:

|                           | #5332                                        | This proposal                             |
| ------------------------- | -------------------------------------------- | ----------------------------------------- |
| User-requested compaction | calls `compact` with `ctx.forced`            | calls `compact` with `ctx.reason`         |
| Kernel owns               | events, memory capture, failure, billing     | the same, plus validation                 |
| Default                   | `fixedTail()`, exported and wrappable        | the same                                  |
| Memory                    | excluded from `history`; recall placed ahead | the same; `tokens.limit` subtracts recall |

Where they differ:

1. **When.** #5332's `shouldCompact` lets a strategy define "too full", receiving
   `thresholdPercent` as `args.threshold`, and grows `CompactionEvent` (`{ type: "step.started" }`
   today) as triggers are added. Here `thresholdPercent` alone defines overflow, and events stay in
   hooks, as `ctx.compact()` requests.
2. **Location.** #5332 discovers `agent/compaction.ts`. Here the strategy is `compaction.compact`
   in `agent.ts`.
3. **General context.** #5332's context exposes `threshold`, `recentWindowSize`, and `forced` to
   every strategy. Here `recentWindowSize` is a `fixedTail()` option, and `ctx` carries only
   measured facts and the reason.
4. **Summaries and checkpoints.** #5332's `summarize({ messages, system })` takes a raw system
   prompt, no input budget, and the configured `compaction.model`. `createCompactionUserMessage`
   doesn't build the head `checkpointLength` recognizes. Here `summarize` uses eve's prompt within
   the summary model's window, takes its model per call, and `ctx.checkpoint()` builds the
   recognized head.
5. **Validation.** #5332's `validateHarnessModelMessages` only checks that user messages carry a
   `kind`. Here eve validates pairing, pending calls, the checkpoint head, and fit.
6. **Events.** #5332 changes `modelId` on `compaction.*` to mean the configured model, and targets
   `main`'s `compaction.*` events. Here events keep their meaning, on #4855's `context.*` events.

From #5332, this proposal keeps the engine's move to `strategies/fixed-tail/`, `measure.ts`,
`compact(history, ctx)`, lazy resolution of the summary model, and the e2e fixture, adapted.

## Open questions

1. **Provider rejections.** eve's measurement is the last reported input count plus a character
   estimate. Should a provider's "context too long" rejection also count as overflow (compact,
   then retry the call)? #4855 doesn't classify those errors today, and their text differs by
   provider.
2. **The output reserve and estimation margin.** Both should be set from measured drift against
   provider counts, not guessed.
3. **Subagent inheritance.** Should a subagent without its own `compaction` use the root agent's
   block, as `limits.sessionUsage` falls back to the root's, or eve's default?
4. **Requests with nothing removed.** eve can verify an overflow result, but can't tell "nothing to
   remove" from "chose not to" on a request. Is the documented obligation enough?
5. **Helpers as public API.** `turns()` and `ctx.checkpoint()` take on the parts that are hardest
   to get right, but each becomes a public promise. Is a `chain()` helper worth adding?
6. **A payload on `ctx.compact()`.** Start without one. The strategy can read `ctx.change` and the
   session view.
7. **Internal path first.** Should compaction and clear share the context-change path before the
   public API ships? That alone removes clear's separate path and lets memory key on a change's
   properties rather than its kind.
