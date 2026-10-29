---
issue: "None (follows the compaction strategy proposal in PR #5361)"
status: proposed
last_updated: "2026-10-28"
---

# Native loop stages

## Summary

A **loop stage** is a function an agent supplies to change one decision of eve's native loop,
without replacing the loop. The first stage, `beforeSettle`, runs when a turn is about to settle
with a reply. It can let the turn settle, or send the model a note and run it again in the same
turn. That is enough for a critic, a citation check, a test gate, or a plan sign-off that the model
must satisfy before the person sees an answer.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  experimental_loop: {
    beforeSettle(turn) {
      if (typeof turn.output === "string" && !/\[\d+\]/.test(turn.output)) {
        return { continue: { note: "Cite a source for each claim, as [1], [2], …" } };
      }
    },
  },
});
```

The stage ships as `experimental_loop` so its shape can change after 1.0 without a major release.

## Why a stage, not a custom loop

eve's loop does two kinds of work. Some of it is a guarantee other parties rely on: a call runs
only after its approvals and sign-ins, every call gets a result before the model reads history,
usage is billed once, and the event stream follows its contract. The rest is opinion: when to
call the model again, what to tell it, when the turn is done. Opinions should be replaceable;
guarantees shouldn't be bypassable.

A stage receives data and returns a decision. eve applies the decision through the same path as
its own choice, so a stage can't publish facts, write history, or skip a gate. This keeps the
first extension small, and it's the shape a full loop policy would take later: a set of decisions,
each with a native default the author can wrap.

## The `beforeSettle` stage

```ts
type BeforeSettle = (
  turn: SettlingTurn,
  ctx: LoopStageContext,
) => BeforeSettleResult | undefined | Promise<BeforeSettleResult | undefined>;

interface SettlingTurn {
  /** The reply the turn would settle with: prose, or the structured value it delivered. */
  readonly output: JsonValue;
  /** The session's history, including this turn's response. */
  readonly history: readonly HistoryMessage[];
  /** How many times this stage continued this turn. */
  readonly continuations: number;
}

interface LoopStageContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

type BeforeSettleResult = { readonly continue: { readonly note: string } };
```

- eve calls the stage when its native loop would settle the turn as completed: after the model
  answered with no outstanding calls, no working tasks, and no hook failure, and, with an output
  schema, after the model delivered a value. A turn that fails, waits, or parks never reaches it.
- `undefined` settles the turn as eve would have.
- `{ continue: { note } }` adds the note to history as an `execution.continuation` message and calls
  the model again in the same turn. The turn's reply is whatever settles last; a client sees one
  `turn.settled`.
- After `maxContinuations` continuations (default 3, at most 10), eve settles without calling the
  stage, so a stage that's never satisfied can't loop forever. eve counts continuations from the
  notes in history; a compaction during the turn can drop notes and restart the count.
- A stage that throws fails the turn. The client sees a generic error; the server log has the
  cause.
- A step that fails and runs again calls the stage again. Effects outside eve need idempotency
  keys, as with compaction strategies.

## Limitations

- A stage that calls a model, for example with `decide` from `eve/ai`, makes a call eve doesn't
  bill to the session's usage or show on its stream. Billing auxiliary calls needs a model effect
  the kernel owns; this proposal doesn't add one.
- A stage sees history and output, not the turn's events. Deciding from tool outcomes means
  reading the tool messages in history.
- The note is the only way to steer the next call. A stage can't change the model, tools, or
  instructions; those belong to later stages.

## Next stages

Each later stage follows the same rules: data in, a decision out, applied by eve.

- `beforeModel`: add ephemeral context or choose the model for the next call.
- `afterModel`: turn a response without calls into a continue, for agents that work in multiple
  steps without tools.
- Custom compaction timing, which [the compaction strategy](./compaction-strategy.md) leaves to
  eve's threshold.

A full custom loop would compose these decisions explicitly. It should wait until the stages show
which decisions authors need.

## Testing

- Unit: config validation (function, `maxContinuations` range, dynamic subagents rejected).
- Integration: a stage that continues once yields two model runs and one `turn.settled` with the
  second reply; the cap settles without calling the stage; a throwing stage fails the turn;
  structured output reaches the stage as a value.
- E2E: a mock-model critic fixture whose first answer lacks a citation and whose second has one.
