---
issue: "None (responds to the compaction strategy proposal in PR #5332)"
status: proposed
last_updated: "2026-10-26"
---

# Authored compaction

## Summary

Let an agent decide what compaction produces and when it runs, using parts eve already has:

- **What:** one strategy function, `compact(history, ctx)`, replacing eve's default `fixedTail()`.
  It's a single-owner value, like `model`.
- **When:** any event. Handlers use the same `events` map as `defineHook`, plus a new request,
  `ctx.compact()`, next to `ctx.cancel()`.

The kernel keeps owning the rewrite itself: its events, memory capture, billing, validation, and
recovery. Internally, nothing is compaction-specific except the transition that rewrites history.
The one generic change is that a session control can come from a reaction or from the kernel, not
only from a delivery.

This is additive. Nothing changes before 1.0. It targets the #4855 session kernel, replacing the
approach in #5332 while reusing its plumbing.

## Authoring API

```ts title="agent/compaction.ts"
import { defineCompaction, fixedTail } from "eve/compaction";

export default defineCompaction({
  // Optional. The same events map as defineHook: keyed by event type, `*` matches every event.
  events: {
    "task.ended"(event, ctx) {
      if (event.data.outcome === "completed") ctx.compact();
    },
  },

  // Optional; defaults to fixedTail(). Runs for every compaction, whatever asked for it.
  async compact(history, ctx) {
    if (ctx.change.trigger !== undefined) return fixedTail().compact(history, ctx);
    const { older, recent } = ctx.split(history, { recentTokens: 4_000 });
    if (older.length === 0) return history;
    return [...ctx.checkpoint(await ctx.summarize(older)), ...recent];
  },
});
```

```ts
interface CompactionStrategy {
  compact(
    history: readonly HistoryMessage[],
    ctx: CompactionContext,
  ): Promise<readonly HistoryMessage[]>;
}

interface CompactionContext {
  /** What this compaction's `context.started` reports: `cause`, `trigger`, `turnId`. */
  readonly change: ContextStartedData;
  /** Estimated tokens in `history`, and the most the result may take. */
  readonly tokens: { readonly history: number; readonly limit: number };
  /** Splits at the latest point that keeps `recentTokens`, never between a call and its result. */
  split(
    history: readonly HistoryMessage[],
    options: { readonly recentTokens: number },
  ): { readonly older: readonly HistoryMessage[]; readonly recent: readonly HistoryMessage[] };
  /** Runs the compaction model over `messages`, billed to the session and retried like eve's own call. */
  summarize(
    messages: readonly HistoryMessage[],
    options?: { readonly instructions?: string },
  ): Promise<string>;
  /** The two messages that open compacted history, in eve's checkpoint format. */
  checkpoint(summary: string): readonly HistoryMessage[];
  estimateTokens(messages: readonly HistoryMessage[]): number;
  readonly abortSignal: AbortSignal;
  // Plus the read-only session view and durable state that hooks get.
}
```

Any hook can also ask for a compaction:

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

`eve/compaction` exports:

- `defineCompaction`;
- `fixedTail({ recentTokens? })`, today's strategy, so a strategy can configure or wrap it;
- the types above.

`HistoryMessage` is eve's own message type, already public through the memory API.

These stay as they are:

- `compaction.model`, `compaction.thresholdPercent`, and `compaction.modelContextWindowTokens` in
  `agent.ts`;
- the client and channel `session.compact()`.

Each agent directory, including each subagent's, resolves its own `compaction.ts` with no
inheritance, the way `memory.ts` works.

## Semantics

### Where compactions come from

| Source                                       | Runs                                                                     | `context.started` reports                           |
| -------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| Threshold: the next request won't fit        | Before the turn's model call                                             | `turnId`, `trigger: { inputTokens }`                |
| `session.compact()` from a client or channel | After the active turn settles, or right away when idle                   | `cause: { deliveryId }`, plus the delivery's events |
| `ctx.compact()` during a turn                | Before the turn's next model call. If the turn makes none, between turns | `turnId`, `cause: { hook }`                         |
| `ctx.compact()` between turns                | Right away, before the next turn starts                                  | `cause: { hook }`, and no delivery events           |

The threshold check stays in the kernel and can't be turned off. It's what guarantees that a model
call fits. Authors tune `thresholdPercent` and decide what a threshold compaction produces.

### Requests

These follow `ctx.cancel()`:

- A request counts only if its handler returns. A handler that requests a compaction and then
  throws fails the turn, and no compaction happens.
- A call after the handler settles throws.

Unlike a cancel, a compaction request isn't tied to a turn, so it also counts between turns.
Repeated requests collapse to one pending compaction. A request made after the session ends is
dropped.

### What eve checks

eve validates only what it depends on:

- Every call stays paired with its result.
- Calls the turn is still waiting on are kept: approvals, sign-ins, suspended steps.
- A checkpoint, if present, opens the history.
- User messages are valid.
- A threshold compaction's result fits `tokens.limit`.

`tokens.limit` subtracts everything added back on every call: instructions, tool schemas, client
context, and recalled memory. Errors name the problem, for example which message is an orphaned
tool result.

### Failure, loops, and recovery

- **Failure.** A threshold compaction that fails fails the step, as today, because the next call
  can't run without it. Any other failed compaction settles `failed`, the history stays as it
  was, and the session continues. That covers a validation error and an exception the strategy
  throws.
- **Loop guard.** There's at most one compaction per step. A request made while a compaction runs
  is dropped. Events a compaction publishes can ask for another only at a later step.
- **Recovery.** The history is replaced in the same commit as `context.settled`. A crash in the
  middle settles the change `interrupted` and leaves the history unchanged. A retried step calls
  `compact` again, so the docs say not to put side effects there that can't repeat.
- **Cancellation.** Cancelling the turn cancels a compaction running inside it. A
  compaction that runs as a control ignores cancel, as it does today.

## Events

There are no new event types or fields.

- **A new value for an existing field.** `context.started.cause` is already the shared `Cause`
  union, which includes `{ hook }`. `turn.settled` already uses `{ hook }` for hook cancellation.
- **One new sequence of existing events.** A compaction a hook asks for between turns publishes
  `context.started` with `cause: { hook }`, then `context.settled`, with no `turnId` and no
  delivery events. Nothing pretends to be a delivery.
- **Which event triggered it isn't published.** `cause` names the hook, not the event that
  triggered it, matching how hook cancels are reported.

## Built from existing primitives

| Primitive      | What it is in #4855                                                                                                                                                          | Change                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Reaction       | `hookReaction` runs an `events` map after each commit (`reactions/kinds/hook.ts`)                                                                                            | None: `defineCompaction`'s `events` become a hook reaction                            |
| Request        | `ctx.cancel()` queues a `PendingIntent`, kept only if the handler returns. The runner acts on it with `takeIntents` and `actOnCancels`                                       | Add a `compact` member, not tied to a turn and collapsed to one pending               |
| Control        | `turn-step.ts` runs a compact-only step (`compactOnly`) only for a client's `compact` delivery                                                                               | A control has a **source**: delivery, reaction, or kernel                             |
| Value          | A function field on `defineAgent`, compiled as a marker and loaded from source, like `limits.sessionUsage`. A dynamic `model` becomes a value reaction (`loadModelReaction`) | The strategy is a function field. A dynamic strategy, if ever needed, follows `model` |
| History writer | `replaceSessionHistory`, called by compaction, clear, and recovery of an interrupted clear                                                                                   | One `applyContextChange` for every context change                                     |

```
delivery (client, channel) ─┐
reaction (hooks)            ├─▶ request { type, cause } ─▶ control ─▶ applyContextChange ─▶ history
kernel (threshold)          ┘    queued, collapsed           compact      strategy, validation
```

`defineCompaction` compiles into these primitives, as `memoryReactions` compiles one memory
definition into a recall value plus capture reactions.

### One writer of history

`replaceSessionHistory` already has three callers, and all three are context changes:

- compaction, in `compaction/step.ts`;
- clear, through `clearContext` in `tool-loop.ts`;
- recovery of an interrupted clear, in `interrupted-step.ts`.

They become one internal function that every compaction source shares:

```ts
// harness/context-change.ts (sketch): the only code that replaces history.
export async function applyContextChange(
  step: Step,
  change: {
    readonly kind: "compaction" | "clear";
    readonly cause?: Cause; // { deliveryId } or { hook }
    readonly trigger?: { readonly inputTokens: number };
    readonly rewrite: (history: readonly HarnessModelMessage[]) => Promise<HarnessModelMessage[]>;
  },
): Promise<HarnessSession> {
  // 1. Commit context.started. Memory's capture before compaction runs on this commit.
  // 2. If capture failed (takeCompactionCaptureFailure), settle failed. History is unchanged.
  // 3. Rewrite. Clear rewrites to []. Compaction calls the strategy, then validates.
  // 4. replaceSessionHistory and context.settled, in one commit.
}
```

### Where memory and compaction meet

Memory never writes history. Recall is a value-reaction slot, and each model call adds it to the
request: `request.ts` calls `messages.addAnchored(memoryRecallContents(ctx), …)`. Capture writes
to the provider's store. The two features touch at two points, and both constrain the rewrite:

- **Capture comes before the rewrite.** Memory's capture before compaction (`compactionCapture`)
  runs after the commit that starts the change, while that commit still carries the old history.
  A capture failure fails the compaction before any rewrite. `applyContextChange` keeps that order
  for every source. The capture's operation id uses the change id, so a compaction a hook asks
  for between turns needs neither a delivery nor a turn.
- **Recall placement depends on the result.** Recall goes just ahead of the input of the turn
  that recalled it. That input carries its turn id in its metadata (`turnAnchorOf`). Recall whose
  anchor was summarized away goes after the checkpoint, which `checkpointLength` recognizes as two
  messages: a user message of kind `context.compaction`, then the summary.
  - That's why `ctx.checkpoint()` returns both messages.
  - It's why `split` keeps kept messages unchanged. A rewritten turn input that loses its anchor
    still works, but its recall moves and the provider's prompt cache misses.

## The same feature without `defineCompaction`

`defineCompaction` adds no capability of its own. Here is the same agent written only with
surfaces that exist today, plus the two additions above: a `compaction.compact` field and
`ctx.compact()`. It's less tidy, with the trigger and the strategy in separate files, but it shows
that everything else is composition.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { fixedTail, type CompactionStrategy } from "eve/compaction";

const compact: CompactionStrategy["compact"] = async (history, ctx) => {
  if (ctx.change.trigger !== undefined) return fixedTail().compact(history, ctx);
  const { older, recent } = ctx.split(history, { recentTokens: 4_000 });
  if (older.length === 0) return history;
  return [...ctx.checkpoint(await ctx.summarize(older)), ...recent];
};

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: {
    thresholdPercent: 0.8, // existing
    compact, // new: a function field, compiled and loaded like limits.sessionUsage
  },
});
```

```ts title="agent/hooks/compact-after-tasks.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    "task.ended"(event, ctx) {
      if (event.data.outcome === "completed") ctx.compact(); // new: a request, like ctx.cancel()
    },
  },
});
```

Client code keeps calling `session.compact()`, which reaches the same strategy as a control
delivery.

`agent/compaction.ts` is sugar for those two files. The compiler emits the artifacts it already
emits for them:

```ts
// What the compiler produces for agent/compaction.ts (sketch).
{
  agent: { compaction: { compact: true } }, // marker; the runtime loads compaction.ts#compact
  hooks: [{ slug: "<reserved compaction slug>", logicalPath: "agent/compaction.ts", events }],
}
```

At runtime, the pieces meet in two places. Both take the queued request the same way
`actOnCancels` takes a cancel:

```ts
// In a turn, before the model call (harness/model-call/call.ts, sketch).
const [requested] = takeIntents(ctx, (intent) => intent.type === "compact");
if (requested !== undefined || thresholdDue) {
  session = await compact(step, requested ? { cause: { hook: labelOf(requested) } } : { trigger });
}

// Between turns, after a commit's reactions ran (session loop, sketch). This is the step a client's
// compact runs (compactOnly), with a reaction as its source instead of a delivery.
const [pending] = takeIntents(ctx, (intent) => intent.type === "compact");
if (pending !== undefined) await runStep({ compactOnly: true, cause: { hook: labelOf(pending) } });

// Every source, one entry (harness/compaction/step.ts, sketch).
function compact(step: Step, source: { cause?: Cause; trigger?: { inputTokens: number } }) {
  const strategy = step.config.compaction?.compact ?? fixedTail().compact;
  return applyContextChange(step, {
    kind: "compaction",
    ...source,
    rewrite: (history) => strategy(history, compactionContext(step, source)),
  });
}
```

Reading the sketch as a whole:

- The threshold doesn't need to go through the queue. It's raised and taken in the same step, so
  it's a request in concept only.
- Today's two entry points, the client compact (`compactHistory`) and the one inside a turn
  (`maybeCompact`), collapse into `compact`.

## Compatibility

- **Persisted state.** The only change is a `compact` member on `PendingIntent` in the reactions
  state's queue. It's additive: checkpoints written before it still read.
- **Events and public types.** Nothing changes.
- **Readers to check before shipping.** Code that assumes `context.started.cause` is always a
  delivery needs a look: the projection, the client reducers, the dev TUI, and the event checker.
- **Optional before 1.0.** Reword the comment on `ContextStartedData.cause` ("The control
  delivery for a manual change") to "What asked for the change, such as a control delivery."

## Relationship to #5332

| Keep                                                                               | Change                                                                                                                |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Discovering, compiling, and resolving `agent/compaction.ts`                        | `shouldCompact` and the `step.started` trigger type: drop them, triggers are requests                                 |
| `fixedTail()` in `strategies/fixed-tail/`, and the guard rule                      | `main`'s `compaction.*` events: use `context.*` on #4855                                                              |
| Resolving the summary model lazily, so a strategy that never summarizes needs none | `threshold` and `recentWindowSize` on the strategy's context: replace with `tokens` and `fixedTail({ recentTokens })` |
| The `agent-compaction-strategy` e2e fixture                                        | `createCompactionUserMessage`: replace with `ctx.checkpoint()`                                                        |
|                                                                                    | Add output validation and `ctx.split`                                                                                 |

## Alternatives considered

- **Compaction as hooks.** Hooks observe committed events and make requests. They don't return
  state. Several subscribers have no rule for merging the histories they'd return, and hooks run
  after events are committed, which is too late for the call that needs the room. Hooks fit the
  trigger, which is why `ctx.compact()` lives there.
- **Dynamic instructions.** They can only add to the prompt, and `evaluate` can't call a model,
  because it runs again on restore. A summary placed in a system instruction would also give
  user and tool text system authority.
- **History as a value a reaction owns.** As a view of what the model sees, this is coherent and
  may be worth its own proposal for trimming and redaction. It can't own stored history, though:
  that would mean two writers, rewrites that never appear in the events, and no summaries.
  It also leaves storage unbounded, since the checkpoint carries every message.
- **Interceptors** (hooks that return values at decision points). A much larger commitment. They
  could later sit under `defineCompaction` without changing it.

## Staging

1. **Internal, no behavior change.**
   - Add the `compact` request member, sources on controls, `applyContextChange`, and the single
     compaction entry.
   - Show that recorded events and checkpoints match before and after.
2. **Internal slot and validation.** `fixedTail()` runs through the slot. Validation applies to
   eve's own output first.
3. **Public.**
   - Add `defineCompaction`, `compaction.compact`, and hook-side `ctx.compact()`, with docs and a
     changeset.
   - Update the readers listed under Compatibility.
   - Add an e2e fixture with a custom strategy and an event trigger. The existing compaction
     evals run unchanged through the slot.

Integration tests run with event checks on. Each gets a negative control that should fail it:

- a request that counts even though its handler threw;
- skipped validation;
- no loop guard;
- delivery events published for a control a reaction raised.

## Open questions

1. **A payload on `ctx.compact()`.** It would be persisted with the request, and collapsing
   repeated requests would need a rule for which payload wins. Start without one; the strategy
   can branch on `ctx.change` and read the session view.
2. **Naming `cause: { hook }` for `defineCompaction`'s own handlers.** A slug like `"compaction"`
   could collide with `agent/hooks/compaction.ts`. A reserved label or the logical path avoids that.
3. **`ctx.split` as public API.** It takes on the hardest part to get right, but where it may split
   becomes a public promise.
4. **Timing.** A client's compact waits for the active turn to settle. A hook's runs before the
   turn's next model call. Keep the difference and document it: clients control a session between
   turns, while hooks act inside the turn.
