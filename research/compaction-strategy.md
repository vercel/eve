---
issue: "None (responds to the compaction strategy proposal in PR #5332)"
status: proposed
last_updated: "2026-10-28"
---

# The compaction strategy

## Summary

A **compaction strategy** is the function that rewrites an agent's stored history when eve
compacts it. eve compacts for two reasons, named as the AI SDK names them:

- **`automatic`:** the next request is larger than the limit `compaction.threshold` sets.
- **`manual`:** a client calls `session.compact()`.

A third reason, `overflow`, is reserved for compacting after a provider rejects a request as too
long. eve doesn't do that yet. Every reason obliges the strategy to compact. eve validates the
result, applies it as a recorded context change, and bills it.

The `compaction` block takes one of two forms. It either configures eve's default strategy, as it
does today, or supplies a custom one in `compact`. `threshold` belongs to both, because it is the
limit the kernel enforces, not part of how a strategy compacts.

When to compact has one place at each level. Basic agents get the threshold and client requests.
Custom timing, such as compacting between the phases of a workflow, belongs to a future
loop-policy API, not to hooks or the strategy. Today's `compaction` block is valid unchanged, so
`compact` is additive and nothing changes before 1.0.

## Authoring API

### The `compaction` block

```ts
type CompactionDefinition =
  | {
      /** The share of the model's window, from 0 to 1, the context may use. Default 0.9. */
      readonly threshold?: number;
      /** eve's default strategy: the model that writes its summary, and that model's window. */
      readonly model?: ModelDefinition;
      readonly modelContextWindowTokens?: number;
    }
  | {
      readonly threshold?: number;
      /** A custom strategy. It chooses its own summary model, if it uses one. */
      readonly compact: CompactionStrategy;
    };
```

Configure eve's default, as today:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: { threshold: 0.8, model: "openai/gpt-5-mini" },
});
```

Or bring your own:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { keepBrief } from "../lib/compaction";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: { threshold: 0.8, compact: keepBrief() },
});
```

The two forms are exclusive. A plain TypeScript union would accept `{ model, compact }`, because
excess-property checks pass when a property exists in any member, so the published type marks each
form's fields `never` in the other. A block that sets both doesn't type-check. eve also rejects it
at load time, for JavaScript, with: "`compaction.model` configures eve's default strategy. With
`compaction.compact`, choose the summary model in the strategy, for example `fixedTail({ model })`."

The rule for what sits on the block: a field belongs there only if the kernel needs it to decide
when to call the strategy. `threshold` qualifies. The summary model doesn't, since only a strategy
that summarizes uses one, and it may want a different model at different times.

`compact` is a function, so the build records only that the agent has one. The runtime loads it
from the agent module, the way it loads `limits.sessionUsage`.

### The strategy

```ts
type CompactionStrategy = (
  history: readonly ModelMessage[],
  ctx: CompactionContext,
) => Promise<readonly ModelMessage[] | undefined> | readonly ModelMessage[] | undefined;

interface CompactionContext {
  readonly reason: "automatic" | "manual" | "overflow";
  readonly session: { readonly id: string };
  readonly change: { readonly changeId: string };
  readonly tokens: {
    /** The most history that fits under the limit, after instructions, tools, and recall. */
    readonly limit: number;
    /** eve's estimate of `messages`, the one it checks the result against. */
    estimate(messages: readonly ModelMessage[]): number;
  };
  /**
   * Summarizes `messages` with eve's checkpoint prompt, billed to the change's summary run.
   * `model` defaults to the turn model. `instructions` extend eve's prompt.
   */
  summarize(
    messages: readonly ModelMessage[],
    options?: { readonly instructions?: string; readonly model?: ModelDefinition },
  ): Promise<string>;
  /** The checkpoint head eve recognizes on the next compaction: a summary of what was removed. */
  checkpoint(summary: string): ModelMessage[];
  readonly abortSignal: AbortSignal;
}
```

| Reason      | Caller                                            | The result                     |
| ----------- | ------------------------------------------------- | ------------------------------ |
| `automatic` | eve, before a model call whose request is too big | must fit within `tokens.limit` |
| `manual`    | `session.compact()`                               | applies at any size            |
| `overflow`  | reserved: a provider rejected the request         | must fit within `tokens.limit` |

`undefined` means there is nothing to remove, for every reason. A strategy has no way to decline,
so it can't drop a request or an overflow by mistake. `reason` is a hint about how hard to compact,
not a branch the strategy must handle.

eve exports the building blocks it uses itself, from `eve/compaction`:

- `fixedTail(options)`: today's behavior, and the strategy the first form of the block configures.
  It caps oversized tool results in older history, with no model call, and summarizes the older
  history only if capping doesn't fit. A manual compaction goes straight to summarizing. Options:
  `model` and `instructions`.
- `turns(history)`: the history in whole turns, so a strategy that drops or summarizes a range
  never separates a call from its result.

A strategy calls `ctx.summarize` as often as it needs, with whichever models it needs, or not at
all. Every call bills the change's one summary run.

## Examples

### A summary prompt for the domain

```ts title="agent/agent.ts"
compaction: {
  threshold: 0.85,
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
import { createHash } from "node:crypto";
import { turns, type CompactionStrategy } from "eve/compaction";
import { archiveStore } from "./archive";

export const archive: CompactionStrategy = async (history, ctx) => {
  const all = turns(history);
  const recent = all.slice(-3).flat();
  const older = all.slice(0, -3).flat();
  if (older.length === 0) return;

  // Keyed by what's archived, so a retried step writes once if the store honors the key.
  const idempotencyKey = createHash("sha256").update(JSON.stringify(older)).digest("hex");
  const ref = await archiveStore.put(ctx.session.id, older, { idempotencyKey });
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

A step that fails and runs again calls the strategy again. Effects outside eve need an idempotency
key derived from their input. eve gives strategies no memo: a compaction runs once per change, and
the checkpoint carries what one compaction leaves the next.

### Through the AI SDK

The AI SDK's `compactMessages` (vercel/ai#24087, in draft) builds a smaller history the same way.
An adapter can run its strategies inside eve's change, so eve keeps the trigger, measurement,
summary execution, memory, events, and billing. A sketch: the draft exports only `compactMessages`
and its default strategy, so `summarize` stands for a strategy factory eve would ask the AI SDK to
export, one that takes an injected summarizer.

```ts title="agent/agent.ts"
import { fromAiSdk } from "eve/compaction";
import { summarize } from "./ai-sdk-strategies";

compaction: {
  compact: fromAiSdk((eve) =>
    summarize({ keepRecentMessages: 4, summarizer: eve.summarizer({ model: "openai/gpt-5-mini" }) }),
  ),
},
```

The adapter passes the strategy only ordinary messages, derives the AI SDK's checkpoint descriptor
from eve's head, and translates eve's history-only limit into a whole-request budget. It waits for
the AI SDK API to settle.

## What eve guarantees

- **The limit.** The limit is the lower of `threshold` of the window and the window less the output
  reserve. eve measures each request and calls the strategy with `reason: "automatic"` before
  calling the provider. This check can't be turned off.
- **Validation.** Every user message keeps its `kind`. Every call stays paired with its result. A
  checkpoint, if present, opens the history. A turn's current input survives. An automatic result
  fits within the limit.
- **The rewrite.** eve owns `context.started` and `context.settled` with `kind: "compaction"`,
  memory capture before the rewrite, billing of `summarize`, and recovery.
- **Loops.** At most one compaction runs per model call. A result equal to its input records no
  change.

When a strategy gets it wrong:

| Mistake                                                      | eve's response                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An automatic result is too large, or `undefined`             | The change fails and the turn fails before the provider call, naming both sizes: "the strategy returned ~142,000 tokens of history; the limit is ~118,000." |
| The strategy throws                                          | The change settles `failed` and history is unchanged. During a turn, the turn fails, as today.                                                              |
| The result separates a call from its result, or drops a kind | The change fails with a validation error that names the call or message.                                                                                    |

eve doesn't fall back to `fixedTail()` when a strategy fails. A silent fallback would hide a broken
strategy, and the precise error is what lets an author or an agent fix it.

## Why this shape

### One limit, and requests

eve already separates bounds from requests elsewhere. `limits.sessionUsage` is a bound the kernel
enforces before model calls, and a client's cancel is a request. Compaction follows the same
split. `threshold` bounds how much of the window the context may use, and `session.compact()` asks
for a compaction now. There is one definition of "too full", and no author function competes with
it.

The cost is staged policies. A strategy can't prune cheaply at 60% and summarize at 90%, because
automatic compaction at 60% obliges it to fit under 60%. Within one call it can still try pruning
first and summarize only if that isn't enough, as `fixedTail()` does.

An earlier draft let hooks ask for a compaction with `ctx.compact()`. It's dropped: a hook runs
after a commit, so its request is a second, delayed timing mechanism beside the threshold. Timing
that depends on what the agent is doing belongs where the loop decides what runs next.

### Rewrites have one owner

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
policies. Handlers whose order matters need one owner who composes them explicitly. Rewriting
history is a transform, so it belongs in the single `compaction` block, and strategies compose by
wrapping each other. A separate `agent/compaction.ts` adds a discovered file type for a value that
has one owner.

### Room to grow

The strategy is an interceptor stack of size one: `(history, ctx) => history | undefined`, called
before the model, validated after. Many "modify history" needs, such as redacting secrets for one
provider or dropping images for a text-only model, are per-request views rather than stored
rewrites, and would be a separate hook point.

### Built with eve

`fixedTail()` should be an ordinary strategy written only with the public surface above:

1. `fixedTail()` imports only `eve/compaction`'s public surface.
2. The kernel holds no compaction policy beyond the limit: no recent window and no summary prompt.
   It measures, calls the strategy, validates, applies, and records.

## Under the hood: a context change

Compaction is one instance of a transition eve's protocol already names.

| Kind of history mutation | Examples                                                | Owner                           |
| ------------------------ | ------------------------------------------------------- | ------------------------------- |
| **Append**               | inputs, model output, tool results                      | the kernel, every step          |
| **Rewrite**              | compaction, clear, recovery of an interrupted clear     | the kernel, as a context change |
| **View**                 | recalled memory and system instructions in each request | prompt assembly                 |

Every history change goes through one writer, `changeHistory`, which resets what eve measured and
announced when history is rewritten (#5566). Manual and automatic compaction share one body that
opens the change, runs the rewrite, and settles it (#5567). Clear stays a single transition: it
calls no model, withdraws what the cleared history asked, and keeps requests relayed from running
tasks.

## Compatibility

- Nothing is required before 1.0. Today's `compaction` block is the first form of the union,
  unchanged. `compact` is additive.
- No new event types or fields. `context.started` already carries `cause` for a manual change and
  `trigger` for an automatic one.
- No persisted state changes.

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

1. **When.** #5332's `shouldCompact` lets a strategy define "too full". Here `threshold` alone
   defines it.
2. **Location.** #5332 discovers `agent/compaction.ts`. Here the strategy is `compaction.compact`
   in `agent.ts`.
3. **Summaries and checkpoints.** #5332's `summarize({ messages, system })` takes a raw system
   prompt and the configured `compaction.model`. Here `summarize` uses eve's prompt, takes its
   model per call, and `ctx.checkpoint()` builds the head eve recognizes.
4. **Validation.** #5332 checks only that user messages carry a `kind`. Here eve validates pairing,
   the checkpoint head, the turn's input, and fit.

From #5332, this proposal keeps `compact(history, ctx)`, the exported default, lazy resolution of
the summary model, and the e2e fixture, adapted.

## Open questions

1. **Provider rejections.** Should a provider's "context too long" rejection compact with
   `reason: "overflow"`, then retry the call? It needs a normalized overflow error first.
2. **The output reserve and estimation margin.** Both should be set from measured drift against
   provider counts, not guessed.
3. **Subagent inheritance.** Should a subagent without its own `compaction` use the root agent's
   block, as `limits.sessionUsage` falls back to the root's, or eve's default?
4. **A dynamic block.** `compaction: defineDynamic((ctx) => …)` would let the threshold follow the
   chosen model. Is it needed?
5. **Helpers as public API.** `turns()` and `ctx.checkpoint()` take on the parts that are hardest to
   get right, but each becomes a public promise.
