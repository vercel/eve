---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-08"
---

# Dynamic participants

Read on `main` at `285d4e09b`, with the redeploy and compaction paths re-checked at `bf82cfa88`. Nothing was prototyped.

## Summary

Dynamic resolvers (`defineDynamic({ events })`) and memory providers key their handlers on stream event names: `session.started`, `turn.started`, `step.started`, `compaction.requested`, `compaction.completed`, and `turn.completed`. But they don't actually observe the stream. The state machine builds fake, unpublished events to drive them: replays of events published earlier, and previews of events about to be published.

That happens for two reasons:

- **Two moments have no event.** Resolvers that pick the model and tools must run before each model call, but the event that records the call, `step.started`, already carries the chosen model. And when a newer deployment takes a session over, session-scoped resolvers refresh with nothing on the stream to say so.
- **Results are re-derived instead of recorded.** Restores, rebinding after a redeploy, and parked steps re-run resolvers on hand-built events.

This doc proposes making the keys true, rather than renaming them:

- [`session-event-lifecycle.md`](./session-event-lifecycle.md) adds the two missing events: `model.requested`, written before the model is chosen, and `session.redeployed`.
- Participants run on committed events, in one pipeline, and their results are recorded so restores reuse them.
- Conditions such as "only compactions" or "only completed turns" are plain functions: guards from `eve/events`, applied with `when`.

The API keeps its shape. `defineDynamic({ events })` and memory's `recall` and `capture` stay, and only the keys that name removed events change. The pipeline can land first; the key changes ship with the event break.

## Participants versus observers

|                  | Observers                                        | Participants                                                                    |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Who              | Hooks, channel handlers                          | Dynamic model, tools, instructions, skills, connections, subagents; memory      |
| Run on           | Committed events                                 | Committed events, before the work that depends on them continues                |
| Can change state | No; they react to what was decided               | Yes; their results feed the model call, and are recorded so restores reuse them |
| Open values      | Branch on them, with a fallback for unknown ones | Check for the values they want, so an unknown kind never triggers them          |

The rule for authors: **observers render whatever arrives; participants opt in to what they understand.**

## Today

### Who runs where

| Key                    | Participants                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `session.started`      | Dynamic model, tools, instructions, skills, connections, subagents                      |
| `turn.started`         | The same, plus memory recall (required) and memory tools                                |
| `step.started`         | Dynamic model and tools; framework connection tools; skill and connection announcements |
| `compaction.requested` | Memory capture                                                                          |
| `compaction.completed` | Memory recall                                                                           |
| `turn.completed`       | Memory capture                                                                          |

Instructions, skills, connections, and subagents are limited to session and turn boundaries, so the model's input doesn't change between tool-loop steps. The rule is enforced in different places for each:

<details>
<summary>Where each participant's restriction is checked</summary>

| Participant  | `defineDynamic` from   | Checked at build                                      | Checked at runtime                                       |
| ------------ | ---------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Tools        | `eve/tools`            | Typed map; all three keys allowed                     | `ALLOWED_DYNAMIC_TOOL_EVENTS`                            |
| Model        | `eve`                  | Typed map; all three keys allowed                     | `ALLOWED_DYNAMIC_MODEL_EVENTS`                           |
| Instructions | `eve/instructions`     | Typed map, plus `normalize-instructions.ts`           | `ALLOWED_DYNAMIC_INSTRUCTION_EVENTS`                     |
| Connections  | `eve/connections`      | Typed map, plus `normalize-connection.ts`             | `ALLOWED_DYNAMIC_CONNECTION_EVENTS`                      |
| Subagents    | `eve`                  | `normalize-subagent.ts`, with its own copy of the set | A second copy in `context/dynamic-subagent-lifecycle.ts` |
| Skills       | `eve/skills`           | None: the shared type allows `step.started`           | `ALLOWED_DYNAMIC_SKILL_EVENTS`                           |
| Memory       | `defineMemoryProvider` | Typed `recall` and `capture` maps                     | An if/else chain on the event type                       |

</details>

A skill resolver keyed on `step.started` compiles, then silently never runs.

### How they're dispatched

**Published events.** `execution/session/turn-event-handler.ts` runs for every event a turn publishes, including each streamed delta, in this order:

1. write the event (channel adapter, then the stream);
2. memory, through the type checks in `dispatchMemoryLifecycleEvent`;
3. hooks;
4. the dynamic model, skipped for `step.started`;
5. connections, subagents, tools, skills, and instructions.

Each dispatcher in steps 4–5 checks its own allowed set and returns early for everything else. Some add special cases:

- tools take a separate branch for `step.started`, reset step metadata on `turn.started`, and clear durable callbacks on `session.completed`;
- skills let `step.started` through to rebuild their announcement, then filter it out before any resolver runs;
- the connection wrapper in `execution/dynamic-connections.ts` announces connections on `step.started`;
- the model dispatcher maps each event type to a durable key, and `step.started` to none.

**Synthetic events.** Several paths need participants to run when nothing is being published. They rebuild an event by hand with the v26 builders, from `harness/session-machine/resolver-events.ts`. Each is a replay of an event published earlier, or a preview of one about to be published, with approximate fields:

<details>
<summary>The six paths, and how they accumulated</summary>

| Path                      | Where                                                  | Rebuilds                          | Differs from the real event                                                  |
| ------------------------- | ------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------- |
| Model selection           | `harness/model-call/run.ts` `selectModel`              | `step.started`, ahead of time     | `modelId` is the static model or `"dynamic"`, since choosing it is the point |
| Redeploy refresh          | `execution/session/turn-step.ts`                       | `session.started`                 | The current deployment's runtime identity; no trace context                  |
| Callback rebind           | `execution/session/turn-step.ts`                       | `turn.started`                    | Replayed in a later step or process                                          |
| Approval turn preparation | `execution/session/turn-step.ts` `prepareApprovalTurn` | `turn.started`, for connections   | Replayed in a later step or process                                          |
| Connection rehydrate      | `execution/dynamic-connections.ts`                     | `session.started`, `turn.started` | Replayed in a later step or process                                          |
| Parked-step tool restore  | `harness/hitl/intake.ts`                               | `step.started`                    | `modelId` placeholder                                                        |

None of them carries `meta` or `at`. Memory never receives one; it runs only on published events.

The pattern is as old as dynamic model selection (#581), which had to choose the model before the model call that the published `step.started` records. Recovery fixes added the replays one at a time (#1133, #1370, #2384, #2738, #2751, #3763, #3983). #4177 gathered them into `resolver-events.ts`.

</details>

**Untyped payloads.** A handler's first argument is `unknown` (`DynamicEvents` in `dynamic/definition.ts`). The docs tell authors to read messages from `ctx` and say only that "the event itself contains turn metadata".

### What that costs

- **The names promise stream facts that aren't there.** A resolver's `step.started` fires before the model call that the published `step.started` describes, and replays carry approximate data.
- **Some keys name events that are going away.** v27 removes `step.started`, `turn.completed`, and the `compaction.*` events, so those keys would name facts that no longer exist.
- **Dispatch is scattered:**
  - six type-filtered dispatch calls, run for every published event, deltas included;
  - allowed sets in several files, one of them duplicated, and one participant with no build-time check;
  - special cases for `step.started`;
  - each re-entry path choosing which event to rebuild.
- **Authors can't rely on the payload,** because it's typed `unknown`.

## Proposal

### The API

Keys are events from the catalog:

```ts
// agent/tools/catalog.ts
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => ({
      search: defineTool({/* … */}),
    }),
    "model.requested": async (_event, ctx) => toolsForMessages(ctx.messages),
  },
});
```

```ts
// agent/agent.ts
export default defineAgent({
  model: defineDynamic({
    events: {
      "session.started": (_event, ctx) => modelForPlan(ctx.session.auth),
      "model.requested": (_event, ctx) => (hasImages(ctx.messages) ? visionModel : null),
    },
  }),
});
```

Memory providers keep their `recall` and `capture` containers, keyed the same way, with guards for conditions:

```ts
import { when, isCompaction, isCompleted } from "eve/events";

defineMemoryProvider({
  recall: {
    "turn.started": recallForTurn,
    "context.settled": when(isCompaction, isCompleted)(restoreAfterCompaction),
  },
  capture: {
    "turn.settled": when(isCompleted)(captureTurn),
    "context.started": when(isCompaction)(captureBeforeCompaction),
  },
});
```

- **Handlers receive the committed event,** with its position, typed by key, and `ctx` (`DynamicResolveContext`) unchanged. Memory handlers move from `(ctx)` to `(event, ctx)`, like every other participant.
- **Every entry point is typed to the events its participant accepts.** `eve/skills` and the subagent form of `eve`'s `defineDynamic` get their own typed variants, so a skill handler on `model.requested` is a type error instead of a resolver that never runs.
- **Old keys fail the build with the fix,** without aliases ([Compatibility](#compatibility)).

### Triggers

| Event                | Condition                     | Participants                                                       | Replaces                                           |
| -------------------- | ----------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `session.started`    | —                             | Dynamic model, tools, instructions, skills, connections, subagents | `session.started`                                  |
| `session.redeployed` | —                             | The same, refreshing session-scoped results                        | The redeploy refresh's synthetic `session.started` |
| `turn.started`       | —                             | Memory recall and memory tools, then the dynamic ones              | `turn.started`                                     |
| `model.requested`    | See below                     | Dynamic model and tools                                            | `step.started`                                     |
| `context.started`    | `isCompaction`                | Memory capture                                                     | `compaction.requested`                             |
| `context.settled`    | `isCompaction`, `isCompleted` | Memory recall                                                      | `compaction.completed`                             |
| `turn.settled`       | `isCompleted`                 | Memory capture                                                     | `turn.completed`                                   |

- **`model.requested`** lands in the commit that makes the next model call necessary: the turn's start, the last call result, an answer, steering, or a completed sign-in. Participants run after it, and `model.started` records the model they chose. It doesn't run again for provider retries inside one run, and a run that replaces an abandoned one reuses that run's decision.
- **Summary runs.** A compaction's summary run uses `compactionModel` if one is configured, otherwise the model the turn's current run chose. Between turns, the dynamic model runs on the summary run's `model.requested`, as manual compaction's synthetic `step.started` does today. Tool participants run only for runs owned by a turn.
- **`session.redeployed`** comes first in the first commit after a newer deployment takes an idle session over, so session-scoped results refresh before turn participants run. A fresh process on the same deployment isn't a redeploy: it rebuilds code from recorded results without deciding them again.
- **Conditions are guards.** Memory's compaction and completed-turn handlers keep today's meaning through `when`. Capturing failed or cancelled turns becomes an opt-in through a different guard, not a new key.
- **The restrictions stay.** Instructions, skills, connections, and subagents accept only `session.started`, `session.redeployed`, and `turn.started`.
- **Framework work moves onto events too.** The skill and connection announcements and the framework connection tools run on `model.requested` as built-in participants, instead of as special cases on `step.started`.

### Guards

`eve/events` exports the catalog's event types and a few plain functions:

- `when(...guards)(handler)` runs the handler only when every guard passes, and narrows the event's type for it.
- `is*` guards for common conditions: `isCompaction`, `isClear`, `isCompleted`, and `isFailed`. `isCompleted` works on any terminal with a `completed` outcome.
- `hasKind("…")` and `hasOutcome("…")` cover the rest, narrowing on the literal.

```ts
export const when =
  <E extends SessionEvent>(...guards: readonly Guard<E>[]) =>
  <R>(handler: (event: E, ctx: ParticipantContext) => R) =>
  (event: E, ctx: ParticipantContext) =>
    guards.every((guard) => guard(event)) ? handler(event, ctx) : undefined;
```

- **Guards check for what they want,** so a clear, or a future kind such as `rewind`, never matches a compaction guard. Docs examples always test positively.
- **A handler whose guard fails returns nothing,** and nothing is recorded.
- **The same guards work in hooks, channel handlers, and view code.** The module has no runtime dependencies, so clients can import it.

### What a handler receives

- **The committed event and `ctx`,** with no `entry` field. A restore rebuilds code from recorded results, using the original event at its position, and a redeploy is its own event.
- **Results are recorded as today,** in the same durable keys, so a restore reuses locked identities instead of resolving again against the current configuration. Resolvers should stay idempotent, as the docs already ask.
- **Stored scope names don't change.** Dynamic tool callbacks persist their scope as `session`, `turn`, or `step`, today derived from the key (`event.type.split(".")[0]`). The registry maps `model.requested` to the stored `step` scope, so a session that spans the deploy restores its locked tools.

### One pipeline

```text
harness/participants/
  triggers.ts   which events each participant accepts, and its built-in eligibility
  registry.ts   participants and their keys, built once from the bundle
  run.ts        runParticipants(commit, ctx): runs participants for each event, in fact order, and records results
```

- **The step that writes a commit calls `runParticipants`** after the commit's observers. Progress never reaches participants.
- **One fixed order per event:** memory first, then the dynamic model, connections, subagents, tools, skills, and instructions, which is today's order. Today's failure rules stay; for example, a throwing `recall` on `turn.started` fails the turn before the model runs.
- **Restores reuse recorded results.** They call into the pipeline only to rebuild code, with the original event.

**Deleted:**

- `harness/session-machine/resolver-events.ts`, and its `modelId: "dynamic"` placeholder;
- the six type-filtered dispatch calls in `turn-event-handler.ts`;
- the memory type checks in `context/memory-event-lifecycle.ts`;
- the `step.started` skip and special cases in the model, tool, skill, and connection dispatchers;
- the `ALLOWED_DYNAMIC_*` sets in the runtime and the compiler, replaced by the typed triggers.

### One ordering change

Today memory runs between the write and the hooks, while the dynamic resolvers run after the hooks. In the pipeline, every participant runs after the commit's observers. The difference isn't visible to hooks, because they never see model messages or memory results. The only effect: a hook that cancels the turn from `turn.started` now stops memory recall from running for a turn that won't call the model.

## Compatibility

The change is smaller than a rename, and ships in the same release as the event break ([`session-event-lifecycle.md`](./session-event-lifecycle.md#compatibility-at-the-break)), so authors migrate once.

- **Unchanged:** `defineDynamic({ events })`, memory's `recall` and `capture`, and every `session.started` and `turn.started` key, which covers most authored resolvers.
- **Renamed keys,** each failing the build with the exact replacement, plus a codemod:
  - `step.started` → `model.requested`;
  - memory's `compaction.requested` → `context.started` with `when(isCompaction)`;
  - `compaction.completed` → `context.settled` with `when(isCompaction, isCompleted)`;
  - `turn.completed` → `turn.settled` with `when(isCompleted)`.
- **Memory handlers take `(event, ctx)`** instead of `(ctx)`.
- **Handler payloads become typed.** The first argument is `unknown` today, so handlers that ignore it keep compiling.
- **Running sessions aren't affected.** Key names aren't persisted, and stored scope names stay as they are.
- **Extension contracts.** One retained epoch (`dynamicTool/v4`) authors a resolver on `step.started` and is dropped with a reason. The other 127 dynamic-capability fixtures keep working.
- **Third-party** memory providers, and resolvers keyed on `step.started`, break until they update.
- **In this repo,** the migration covers:
  - 15 e2e fixture files and 3 framework source files (`models/auto.ts`, `tools/framework/connection-tools.ts`, and the `defineDynamic` types) that key resolvers on `step.started`;
  - the file memory provider and two e2e memory fixtures;
  - the dynamic capabilities guide and the custom memory provider guide.

## Plan

1. **Land after HumanInput (#4342–#4344).** The pipeline touches `execution/session/turn-step.ts`, `harness/model-call/run.ts`, and `harness/hitl/intake.ts`, all of which HumanInput changes.
2. **Add the pipeline behind today's API.** The triggers, the registry, and `runParticipants`, with today's keys mapped onto events internally. Then move dispatch onto it one participant at a time, with today's scenario tests pinning order and timing:
   - memory recall before the first model call;
   - dynamic model selection per model call, and for a manual compaction;
   - the refresh after a redeploy;
   - restoring a parked step's tools.

   This part changes nothing for authors and can land on its own.

3. **In the event break's release:** the renamed keys, memory's handler shape, typed entry points, `eve/events`, the build errors, the codemod, and the repo migration.
4. **Switch the docs.**

**Size:** a small net reduction, not measured. The dispatch and synthetic-event code it removes is a few hundred lines across `turn-event-handler.ts` (140), `resolver-events.ts` (29), `memory-event-lifecycle.ts` (76), and the filtering parts of the six `context/dynamic-*-lifecycle.ts` files. The pipeline and guards add back something smaller.

## Open questions

1. **Is the ordering change acceptable?** The alternative is for the turn step to run memory between the write and the hooks, as today. That keeps a second, special-cased path into the pipeline.
