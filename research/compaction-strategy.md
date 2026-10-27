---
issue: "None (responds to the compaction strategy proposal in PR #5332)"
status: proposed
last_updated: "2026-10-27"
---

# The compaction strategy

## Summary

A **compaction strategy** is the agent's policy for its own history. Before each model call it
decides whether the stored conversation should be rewritten to make room, and when it should, it
produces the replacement. eve validates the replacement, applies it as a recorded context change,
and bills it.

The proposal has three parts:

1. **The strategy is the `compaction` value in `agent.ts`.** Today's block becomes shorthand for
   eve's default strategy, so `thresholdPercent` and the summary model are that strategy's
   settings, not a separate "when" mechanism. The value can also be a strategy object, or a
   dynamic value.
2. **Hooks ask, they don't rewrite.** `ctx.compact()` asks for a compaction, the way `ctx.cancel()`
   asks for a cancel. Any number of hooks can ask. The strategy decides how.
3. **The kernel keeps the guarantees.** A request must fit, so on overflow eve requires the
   strategy to compact. eve validates every result, owns the events, and stops loops.

Basic customization stays configuration: `compaction: { thresholdPercent: 0.8 }`. Nothing changes
before 1.0. The design targets the #4855 session kernel and its `context.*` events.

## Authoring API

### The `compaction` value

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  // Today's form, unchanged: settings for eve's default strategy.
  compaction: { thresholdPercent: 0.8, model: "openai/gpt-5-mini" },
});
```

The object is shorthand for `fixedTail(options)`. `compaction` also accepts a strategy:

```ts title="agent/agent.ts"
import { fixedTail } from "eve/compaction";
import { keepBrief } from "../lib/compaction";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: keepBrief(fixedTail({ thresholdPercent: 0.8 })),
});
```

An agent has exactly one strategy. Strategies compose by wrapping each other, so their order is
written down by the one owner that chose them.

### The strategy

```ts
interface CompactionStrategy {
  /** Whether to compact on the strategy's own initiative before this model call. Sync and cheap. */
  shouldCompact?(ctx: CompactionPressure): boolean;
  /**
   * The replacement for `history`. Called on initiative, on request, and on overflow.
   * `undefined` means there is nothing to remove.
   */
  compact(
    history: readonly ModelMessage[],
    ctx: CompactionContext,
  ): Promise<readonly ModelMessage[] | undefined> | readonly ModelMessage[] | undefined;
}

interface CompactionPressure {
  readonly tokens: {
    /** eve's measurement of the next request, including instructions, tools, and recall. */
    readonly request: number;
    /** The turn model's context window. */
    readonly window: number;
  };
}

interface CompactionContext extends SessionFrame {
  // session, channel, conversation, view, turn, now
  readonly reason: "initiative" | "requested" | "overflow";
  readonly change: { readonly changeId: string };
  readonly tokens: CompactionPressure["tokens"] & {
    /** The most history that fits: the window less the output reserve, instructions, tools, and recall. */
    readonly limit: number;
    estimate(messages: readonly ModelMessage[]): number;
  };
  /**
   * Summarizes `messages` with eve's checkpoint prompt, within the summary model's window, billed
   * to the session. `model` defaults to the turn model.
   */
  summarize(
    messages: readonly ModelMessage[],
    options?: { readonly instructions?: string; readonly model?: string },
  ): Promise<string>;
  /** The two-message checkpoint head eve recognizes on the next compaction. */
  checkpoint(text: string): ModelMessage[];
  readonly memo: Memo;
  readonly abortSignal: AbortSignal;
}
```

Who calls what:

| Reason       | Caller                                            | `shouldCompact` | `compact`                    |
| ------------ | ------------------------------------------------- | --------------- | ---------------------------- |
| `initiative` | eve, before each model call                       | asked first     | called if it returned `true` |
| `requested`  | `ctx.compact()` in a hook, or `session.compact()` | skipped         | called                       |
| `overflow`   | eve, when the request will not fit                | skipped         | called; the result must fit  |

`undefined` from `compact` means the same thing for every reason: nothing to remove. Declining a
compaction is only possible in `shouldCompact`, so a strategy cannot silently drop a request.
`reason` is a hint about how hard to compact, not a branch the strategy must handle. A strategy
without `shouldCompact` compacts only when asked or on overflow.

`shouldCompact` sees numbers only, as in #5332. It runs before every model call, so it stays cheap,
and event-shaped decisions belong in hooks.

eve exports the building blocks it uses itself:

- `fixedTail(options)`: today's behavior. `shouldCompact` compares `tokens.request` with
  `thresholdPercent` of the window. `compact` caps oversized tool results in older history, with
  no model call, and summarizes the older history only if capping is not enough. A request skips
  straight to summarizing. Options: `thresholdPercent`, `model`, `modelContextWindowTokens`,
  `recentTokens`, `instructions`.
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

A request calls `compact` at any size. `thresholdPercent` is the strategy's initiative, and a
request is a separate reason to act, so neither gates the other.

### The value can be dynamic

```ts title="agent/agent.ts"
import { defineAgent, defineDynamic } from "eve";
import { fixedTail } from "eve/compaction";
import { slidingWindow } from "../lib/compaction";

export default defineAgent({
  model: defineDynamic((ctx) => pickModel(ctx)),
  compaction: defineDynamic((ctx) =>
    ctx.model.id.startsWith("openai/") ? slidingWindow : fixedTail({ thresholdPercent: 0.85 }),
  ),
});
```

This is the dynamic `model` pattern. The value is evaluated after the model is chosen, so it can
read `ctx.model.id`.

## Examples

### Keep the original brief

Summaries tend to lose the details of a long task given up front.

```ts title="lib/compaction.ts"
import { fixedTail, type CompactionStrategy } from "eve/compaction";

export const keepBrief = (inner: CompactionStrategy = fixedTail()): CompactionStrategy => ({
  shouldCompact: inner.shouldCompact,
  async compact(history, ctx) {
    const [brief, ...rest] = history;
    const compacted = await inner.compact(rest, ctx);
    return compacted && [brief, ...compacted];
  },
});
```

### Sliding window, no model call

```ts title="lib/compaction.ts"
import { turns, type CompactionStrategy } from "eve/compaction";

export const slidingWindow: CompactionStrategy = {
  shouldCompact: ({ tokens }) => tokens.request > tokens.window * 0.8,
  compact(history, ctx) {
    const kept = turns(history);
    const before = kept.length;
    while (kept.length > 1 && ctx.tokens.estimate(kept.flat()) > ctx.tokens.limit * 0.5) {
      kept.shift();
    }
    if (kept.length === before) return;
    return [...ctx.checkpoint("Earlier turns were removed to save space."), ...kept.flat()];
  },
};
```

### A summary prompt for the domain

```ts title="agent/agent.ts"
compaction: fixedTail({
  thresholdPercent: 0.85,
  instructions: [
    "Keep every ticket ID, order number, and refund amount exactly as written.",
    "List each commitment made to the customer and whether it was fulfilled.",
  ].join("\n"),
}),
```

### Archive older history to a store

```ts title="lib/compaction.ts"
import { turns, type CompactionStrategy } from "eve/compaction";
import { archiveStore } from "./archive";

export const archive: CompactionStrategy = {
  shouldCompact: ({ tokens }) => tokens.request > tokens.window * 0.8,
  async compact(history, ctx) {
    const all = turns(history);
    const recent = all.slice(-3).flat();
    const older = all.slice(0, -3).flat();
    if (older.length === 0) return;

    const ref = await ctx.memo(["archive", ctx.change.changeId], ({ idempotencyKey }) =>
      archiveStore.put(ctx.session.id, older, { idempotencyKey }),
    );
    const brief = await ctx.summarize(older, { instructions: "Two or three sentences." });
    return [
      ...ctx.checkpoint(
        `${brief}\n\nEarlier turns are archived as ${ref}; call recall_archive to read them.`,
      ),
      ...recent,
    ];
  },
};
```

A memo keyed by the change writes to the store once even if the step is retried, provided the
store honors the idempotency key. Memos are a cache: a deployment change discards them, and the key
repeats.

## What eve guarantees

- **Fit.** eve measures each request. When it will not fit, eve calls `compact` with
  `reason: "overflow"` before calling the provider. This isn't configurable.
- **Validation.** Every call stays paired with its result. Calls the turn waits on are kept. A
  checkpoint, if present, opens the history. An overflow result fits.
- **The rewrite.** eve owns `context.started` and `context.settled` with `kind: "compaction"`,
  memory capture before the rewrite, billing of `summarize`, and recovery.
- **Loops.** At most one compaction runs per step. An initiative compaction needs history to have
  grown since the last change. A result equal to its input records no change.

When a strategy gets it wrong:

| Mistake                                                              | eve's response                                                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An overflow result is too large, or `undefined`                      | The step fails before the provider call, naming the strategy and both sizes: "`slidingWindow` returned 142,000 tokens of history; the request allows 118,000." |
| `compact` throws                                                     | The change settles `failed` and history is unchanged. On overflow, the step fails, as today.                                                                   |
| The result separates a call from its result, or drops a pending call | The change fails with a validation error that names the strategy and the call.                                                                                 |
| `shouldCompact` always returns `true`                                | The loop guards above apply.                                                                                                                                   |

eve doesn't fall back to `fixedTail()` when a strategy fails. A silent fallback would hide a broken
strategy, and the precise error is what lets an author or an agent fix it.

## Why this shape

### "When" depends on "what"

How full history may get before compacting depends on how the strategy compacts. Pruning runs no
model, so it can wait longer and act often. Summarizing needs room for the summary prompt and its
output. A strategy that pins messages may have nothing to remove until much later. So
`thresholdPercent` belongs to the strategy, as a setting of `fixedTail()`, rather than standing
beside it as a second trigger.

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
the single `compaction` value, and the strategies in it compose by wrapping.

### Hooks don't rewrite history

Hooks run after a commit. A rewrite requested there is stale by the next model call, could not
serve the overflow case, would let any hook (including one from a third-party extension) edit the
transcript, and would need an ordering mechanism across files. A separate `agent/compaction.ts`
adds a discovered file type for a value that has one owner. Neither is needed.

### Room to grow

The strategy is an interceptor stack of size one: `(history, ctx) => history | undefined`, called
before the model, validated after. If several owners ever need to contribute, `compaction` becomes
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
4. The kernel holds no compaction policy: no threshold, recent window, or summary prompt. It
   measures, calls the strategy, validates, applies, and records.

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

| Property                         | Compaction                          | Clear                            |
| -------------------------------- | ----------------------------------- | -------------------------------- |
| New history                      | the strategy's result               | empty                            |
| `selects`                        | none                                | emptied                          |
| Pending calls in removed history | must be kept                        | their interactions are withdrawn |
| Memory                           | capture before the rewrite          | recall starts over               |
| Where it runs                    | inside a turn or as a control       | as a control only                |
| Who asks                         | the strategy, eve, a client, a hook | a client                         |

One internal path can apply both:

1. Commit `context.started`. Reactions keyed on it run, including memory's capture.
2. Run the rewrite: the strategy's `compact`, or clear's empty history.
3. Withdraw interactions whose call was removed, or reject the result if the kind must keep them.
4. Validate.
5. Replace history and commit `context.settled`, with `selects`, together.

Clear's withdrawals aren't purely derived from removed calls: it also withdraws the session-limit
prompt and keeps requests relayed from running tasks. The shared path has to keep those exactly.
Authored rewrites of other kinds, such as redacting on request, are possible on the same path but
not proposed.

## Compatibility

- Nothing is required before 1.0. The `compaction` object keeps its fields and meaning.
- Optional before 1.0: describe the block in the docs as "settings for eve's default compaction
  strategy" rather than "when compaction runs", so the strategy form reads as an extension of it.
- Optional before 1.0: reword the comment on `ContextStartedData.cause` to "What asked for the
  change, such as a control delivery."
- No new event types or fields. A hook's request reports `cause: { hook }`, which the `Cause`
  union already allows. Between turns, it reports no delivery events.
- The one persisted change is a new pending request in the reactions state. It's additive, so
  existing checkpoints still read.
- Readers that assume `context.started.cause` is a delivery need checking before shipping: the
  projection, client reducers, the dev TUI, and the event checker.

## Relationship to #5332

#5332 adds `agent/compaction.ts` with `defineCompaction({ shouldCompact, compact })`. The two
designs agree on most of the shape:

|                           | #5332                                             | This proposal                             |
| ------------------------- | ------------------------------------------------- | ----------------------------------------- |
| Members                   | `shouldCompact(args)` and `compact(history, ctx)` | the same                                  |
| User-requested compaction | skips `shouldCompact`; `ctx.forced`               | skips `shouldCompact`; `ctx.reason`       |
| `shouldCompact` inputs    | measured numbers only                             | the same                                  |
| Kernel owns               | events, memory capture, failure, billing          | the same, plus validation and overflow    |
| Default                   | `fixedTail()`, exported and wrappable             | the same                                  |
| Memory                    | excluded from `history`; recall placed ahead      | the same; `tokens.limit` subtracts recall |

Where they differ:

1. **Location.** #5332 discovers `agent/compaction.ts` and keeps `thresholdPercent` in `agent.ts`,
   passing it in as `args.threshold`, so "when" spans two files. Here the strategy is the
   `compaction` value, and `thresholdPercent` is a `fixedTail()` setting.
2. **Triggers.** #5332 grows `CompactionEvent` (`{ type: "step.started" }` today) as triggers are
   added. Here events stay in hooks, as `ctx.compact()` requests.
3. **General context.** #5332's context exposes `threshold` and `recentWindowSize` to every
   strategy. Here those are `fixedTail()` options, and `ctx` carries only measured facts.
4. **Summaries and checkpoints.** #5332's `summarize({ messages, system })` takes a raw system
   prompt and no input budget, and `createCompactionUserMessage` doesn't build the head
   `checkpointLength` recognizes. Here `summarize` uses eve's prompt within the summary model's
   window, and `ctx.checkpoint()` builds the recognized head.
5. **Overflow and validation.** #5332 has no overflow reason, and `validateHarnessModelMessages`
   only checks that user messages carry a `kind`. Here overflow is a reason, and eve validates
   pairing, pending calls, the checkpoint head, and fit.
6. **Events.** #5332 changes `modelId` on `compaction.*` to mean the configured model, and targets
   `main`'s `compaction.*` events. Here events keep their meaning, on #4855's `context.*` events.

From #5332, this proposal keeps the engine's move to `strategies/fixed-tail/`, `measure.ts`, the
strategy interface and its name `shouldCompact`, lazy resolution of the summary model, and the e2e
fixture, adapted.

## Open questions

1. **Subagent inheritance.** Should a subagent without its own `compaction` use the root agent's
   strategy, as `limits.sessionUsage` falls back to the root's, or eve's default?
2. **The overflow margin.** The measurement is the last reported input count plus a character
   estimate of what was appended. The margin `tokens.limit` leaves for estimation error should be
   set from measured drift against provider counts, not guessed.
3. **Requests with nothing removed.** eve can verify an overflow result, but can't tell "nothing to
   remove" from "chose not to" on a request. Is the documented obligation enough?
4. **Helpers as public API.** `turns()` and `ctx.checkpoint()` take on the parts that are hardest
   to get right, but each becomes a public promise. Is a `chain()` helper worth adding?
5. **A payload on `ctx.compact()`.** Start without one. The strategy can read `ctx.change` and the
   session view.
6. **Internal path first.** Should compaction and clear share the context-change path before the
   public API ships? That alone removes clear's separate path and lets memory key on a change's
   properties rather than its kind.
