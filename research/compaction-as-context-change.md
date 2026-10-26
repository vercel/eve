---
issue: "None (responds to the compaction strategy proposal in PR #5332)"
status: proposed
last_updated: "2026-10-26"
---

# Compaction as a context change

## Summary

Agents should be able to decide what compaction produces and when it runs. This document makes
two points:

1. **The intended API is small.** A `compact` function goes in the existing `compaction` block of
   `agent.ts`. The block can be a function of context, the way `model` is. Hooks can ask for a
   compaction with `ctx.compact()`, the same way they ask for a cancel.
2. **None of it is built just for compaction.** Underneath, compaction is one instance of a
   general transition eve's protocol already names: the **context change**. Clear is the other.
   The implementation generalizes concepts eve already has (requests, controls, value slots, and
   one writer of history), and a second section shows how.

The second section is an argument about internals, not an API proposal. The generic authoring
surface it sketches is an illustration only.

Everything here is additive, and nothing changes before 1.0. The design targets the #4855 session
kernel.

## Intended API

### The strategy lives in agent configuration

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { fixedTail } from "eve/compaction";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: {
    model: "openai/gpt-5-mini", // existing
    thresholdPercent: 0.8, // existing
    compact: fixedTail({ recentTokens: 8_000 }), // new; defaults to fixedTail()
  },
});
```

`compact` is any function with this signature:

```ts
type CompactionStrategy = (
  history: readonly HistoryMessage[],
  ctx: CompactionContext,
) => Promise<readonly HistoryMessage[]>;
```

`ctx` gives the strategy everything it needs:

- `change`: what this compaction's `context.started` reports (`cause`, `trigger`, `turnId`);
- `tokens.history` and `tokens.limit`: how big the history is, and how big the result may be;
- `split`: separates older messages from recent ones without separating a call from its result;
- `summarize`: runs `compaction.model`, billed to the session;
- `checkpoint`: builds eve's two-message checkpoint head;
- `estimateTokens` and an `abortSignal`.

The strategy can do anything else it likes, including call external services. For example, it can
prune or redact old tool outputs, keeping each call paired with its result, and summarize only
if that isn't enough.

`fixedTail()` is today's behavior, exported so a strategy can configure or wrap it. It first caps
oversized tool results in the older history, keeping each output's head and tail, with no model
call. It summarizes the older history only if capping doesn't make enough room. The recent
messages stay word for word.

An agent has exactly one strategy, as today, so configuration is its natural home. It needs no
new file convention and no new definition type. A function field on `defineAgent` already exists:
`limits.sessionUsage`.

### The block can be a function of context

```ts title="agent/agent.ts"
import { defineAgent, defineDynamic } from "eve";
import { fixedTail } from "eve/compaction";

export default defineAgent({
  model: defineDynamic((ctx) => pickModel(ctx)),
  compaction: defineDynamic((ctx) => ({
    thresholdPercent: ctx.model.id.startsWith("anthropic/") ? 0.85 : 0.75,
    compact: fixedTail({ recentTokens: 8_000 }),
  })),
});
```

This is the dynamic `model` pattern. The block is either concrete or a resolver, never both. It
returns the same fields the static block takes, and it's evaluated after the model is chosen, so it
can read `ctx.model.id`.

The threshold stays a number, not a predicate. Dynamic values are evaluated when a step starts,
before eve measures the request. A number chosen from context can be compared with the measured
prompt at the point where eve measures it. A predicate would need a second evaluation point
after measurement.

### Hooks decide when, beyond size

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
- During a turn, it runs before the next model call. Between turns, it runs right away.

Any logic about when to compact belongs in a hook, whether it reads events, session state,
memos, or external services.

### What eve keeps

- **Size.** The threshold check stays in the kernel and can't be turned off; it's what keeps a
  model call from overflowing. Authors tune it with `thresholdPercent`. Hooks can add
  compactions but never prevent one.
- **The rewrite.** eve owns the events (`context.started` and `context.settled` with
  `kind: "compaction"`), memory capture before the rewrite, billing, and recovery.
- **Validation.** Every call stays paired with its result. Calls the turn waits on are kept.
  A checkpoint, if present, opens the history. A threshold compaction must fit. A compaction that
  fails validation settles `failed` and leaves history unchanged, except a threshold compaction,
  which fails its step as today.
- **The loop guard.** There's at most one compaction per step.

No new event types or fields are needed. A compaction a hook asks for reports `cause: { hook }`,
which the existing `Cause` union already allows. Between turns, it reports no delivery events.

## Not built just for compaction

This section shows that the API above sits on a general mechanism. It isn't a proposal to expose
that mechanism. The code below is illustrative.

### Three kinds of history mutation

| Kind        | Examples                                                                  | Owner                           |
| ----------- | ------------------------------------------------------------------------- | ------------------------------- |
| **Append**  | inputs, model output, tool results, cancelled calls answered as cancelled | the kernel, every step          |
| **Rewrite** | compaction, clear, recovery of an interrupted clear                       | the kernel, as a context change |
| **View**    | recalled memory placed in each request, system instructions               | prompt assembly, from reactions |

Compaction is a rewrite. eve's protocol already treats rewrites generically:

- `context.started` and `context.settled` carry an open `kind`;
- `selects` describes a change's effect on the conversation: unchanged, emptied, or rewound to a
  turn;
- usage can be owned by a change (`{ changeId }`).

The code doesn't treat them as one yet. Compaction and clear take separate paths that both end in
`replaceSessionHistory`.

### Compaction and clear are one transition with different properties

| Property                               | Compaction                    | Clear                            |
| -------------------------------------- | ----------------------------- | -------------------------------- |
| New history                            | summary and recent messages   | empty                            |
| Effect on the conversation (`selects`) | none                          | emptied                          |
| Pending calls in removed history       | must be kept                  | their interactions are withdrawn |
| Memory                                 | capture before the rewrite    | recall starts over               |
| Where it runs                          | inside a turn or as a control | as a control only                |
| Who asks                               | threshold, client, hook       | client                           |

Each row is a property every rewrite has, with one value per kind. Only "a summary needs a
model" is specific to compaction, and that's just what its rewrite does.

### A generic internal shape

```ts
// Illustrative. An internal description of a rewrite.
interface ContextChangeKind {
  readonly kind: string;
  readonly rewrite: (
    history: readonly Message[],
    ctx: ChangeContext,
  ) => Promise<readonly Message[]>;
  /** Effect on the conversation: unchanged (undefined), emptied (null), or rewound to a turn. */
  readonly selects?: (result: readonly Message[]) => null | { readonly turnId: string } | undefined;
  /** Whether it may run before a model call inside a turn, or only as a control between turns. */
  readonly inTurn: boolean;
}

// eve's two kinds, described with the same shape.
const compaction: ContextChangeKind = { kind: "compaction", rewrite: fixedTail(), inTurn: true };
const clear: ContextChangeKind = {
  kind: "clear",
  rewrite: async () => [],
  selects: () => null,
  inTurn: false,
};
```

One shared path applies any kind:

1. Commit `context.started`. Reactions keyed on it run, including memory's capture.
2. Run the kind's rewrite.
3. Withdraw interactions whose call the rewrite removed, or reject the result if the kind must
   keep them.
4. Validate.
5. Replace history and commit `context.settled`, with `selects`, together.

`compaction.compact` in `agent.ts` is configuration for one kind: it replaces that kind's rewrite.

### Built from concepts eve already has

| Concept            | Where it exists today                                                    | How the mechanism uses it                                                                        |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Reactions          | Hooks run their `events` map after each commit                           | Triggers are ordinary hooks                                                                      |
| Requests           | `ctx.cancel()` queues a pending intent, kept only if the handler returns | A change request, `{ type: "change", kind }`; `ctx.compact()` asks for `"compaction"`            |
| Controls           | Clients send compact and clear as control deliveries                     | A control has a source: a delivery, a reaction, or the kernel. The threshold is a kernel request |
| Value slots        | `model` and `limits.sessionUsage`, static or dynamic                     | A kind's rewrite is a slot with a default                                                        |
| One history writer | `replaceSessionHistory` is shared by compaction, clear, and recovery     | Every kind goes through the shared path above                                                    |
| Memory reactions   | Capture keyed on compaction; recall reset keyed on clear                 | Keyed on a change's properties (removes history, `selects: null`), not its kind                  |

```
delivery (client) ─┐
reaction (hooks)   ├─▶ request { kind, cause } ─▶ context change ─▶ kind's rewrite ─▶ history
kernel (threshold) ┘                               (shared path)
```

### Where it could go, and what's hard

The same shape could describe rewrites that aren't compactions. These run for a reason other than
size and report their own `kind`: redacting on request, or rewinding to a turn.
`selects: { turnId }` already anticipates rewinding. A compaction can already prune or redact as
part of making room. A separate kind is for a change that has to happen whether or not the history
is large. An authored kind might look like this:

```ts
// Illustration only. Not proposed.
export default defineContextChange({
  async rewrite(history) {
    return history.map(redactOldToolOutputs);
  },
});
```

Doing this well has real costs:

- **Withdrawals.** Clear's withdrawals aren't purely derived from removed calls. It also withdraws
  the session-limit prompt and keeps requests relayed from running tasks. A generic rule has to
  reproduce those exactly, or keep them as declared exceptions.
- **Authority.** A rewrite that changes the conversation is destructive. Authored kinds shouldn't
  be requestable by clients unless they opt in.
- **Timing.** A kind that changes the conversation can't run inside a turn, because the turn's own
  events would refer to a conversation that no longer exists.
- **Readers.** Readers of `context.*` would have to key on `selects` and `outcome`, never on
  `kind`. The open `ContextKind` already asks for this.

The point isn't to ship this surface. It's that compaction rests on the general mechanism, so the
intended API leaves room for it.

## Compatibility

- Nothing is required before 1.0.
- The only persisted change is a new request in the reactions state's queue. It's additive, so
  existing checkpoints still read.
- Readers that assume `context.started.cause` is always a delivery need checking before shipping:
  the projection, client reducers, the dev TUI, and the event checker.
- Optional before 1.0: reword the comment on `ContextStartedData.cause` to "What asked for the
  change, such as a control delivery."

## Relationship to #5332

#5332 adds `agent/compaction.ts` with `defineCompaction({ shouldCompact, compact })`.

This proposal keeps:

- `fixedTail()` as a reusable default;
- resolving the summary model lazily, so a strategy that never summarizes needs none;
- the e2e fixture, adapted.

It changes:

- the strategy moves into `agent.ts` configuration, replacing the new file and definition;
- triggers become hook requests instead of `shouldCompact`;
- the design moves to #4855's `context.*` events;
- it adds output validation and `split`.

## Open questions

1. **Subagent inheritance.** Should a subagent without its own `compaction.compact` use the root
   agent's strategy, as `limits.sessionUsage` falls back to the root's, or eve's default?
2. **Renaming `thresholdPercent`.** An absolute threshold would follow `{ percent } | { tokens }`
   only if it's renamed before 1.0. After 1.0 it would be an additive `thresholdTokens`. A percent
   follows the model when the model is dynamic, so a rename may not be worth it.
3. **A payload on `ctx.compact()`.** Start without one. The strategy can branch on `ctx.change`.
4. **`split` as public API.** It takes on the hardest part to get right, but it makes where a split
   falls a public promise.
5. **Internal primitive first.** Should compaction and clear share the context-change path before
   the public API ships? That alone removes clear's separate path, and gives memory a rule based
   on properties rather than kind names.
