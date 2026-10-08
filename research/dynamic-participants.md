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

- **One moment has no event.** Resolvers that pick the model and tools must run before each model call, but the event that records the call, `step.started`, already carries the chosen model.
- **Re-runs use hand-built events.** Restores, the refresh after a redeploy, and parked steps re-run resolvers on events rebuilt by hand, with approximate fields, instead of the events that were actually published.

This doc proposes making participants actual consumers of the stream:

- [`session-event-lifecycle.md`](./session-event-lifecycle.md) adds the missing event, `model.requested`, written before the model is chosen. Redeploys need no event: eve re-runs session-scoped participants with the session's original `session.started`.
- **Each participant is one function per action** over committed events: `resolve(event, ctx)` for dynamic resolvers, and `recall(event, ctx)` and `capture(event, ctx)` for memory.
- **A dynamic resolver declares its `scope`:** once per session, per turn, or per model call. That decides which events it receives, so a resolver never runs more often than it asked to.
- **Memory receives a fixed set of moments,** narrowed by eve: it sees completed compactions, never clears. Authors branch only to tell those moments apart.
- Participants run in one pipeline, and their results are recorded so restores reuse them.

The pipeline can land first. The new API ships with the event break, so authors migrate once.

## Participants versus observers

|                  | Observers                                    | Participants                                                                    |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Who              | Hooks, channel handlers                      | Dynamic model, tools, instructions, skills, connections, subagents; memory      |
| Run on           | Committed events                             | Committed events, before the work that depends on them continues                |
| Can change state | No; they react to what was decided           | Yes; their results feed the model call, and are recorded so restores reuse them |
| Receive          | Every event they subscribe to                | Only the events their kind accepts, narrowed by eve                             |
| Unknown values   | Branch on them, with a fallback              | Never see them: a new kind reaches a participant only if eve adds it            |
| Shape            | A handler per event type, plus `*` for hooks | One function per action                                                         |

The rule for authors: **observers render whatever arrives; participants handle the few moments that matter to them.**

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

- **The names promise stream facts that aren't there.** Model selection shows it most clearly, and the proposal changes what the resolver receives rather than when it runs:

  ```text
  today     build step.started {modelId: "dynamic"}   unpublished, no meta
            → the resolver picks the model
            → publish step.started {modelId: chosen}  a different event
            → provider call

  proposed  commit model.requested {runId, owner}     published at position N
            → the resolver receives that exact fact
            → commit model.started {runId, modelId}   the decision lands on the next fact
            → provider call
  ```

  - **Today the resolver's input depends on its own answer,** so `modelId` is a placeholder and the event can't be published first. `model.requested` holds nothing the resolver decides, so it's written first and handed over as is.
  - **Replays change the same way.** Restores, the refresh after a redeploy, and parked steps pass the real `session.started`, `turn.started`, or `model.requested`, rebuilt exactly from the fold with their positions, instead of approximations from the v26 builders.
  - **Two things do move earlier.** Readers see a model call coming before the model is chosen, which lets clients show "preparing" and evals time resolution. Hooks see `model.requested` before participants run, since participants run after a commit's observers; hooks never saw the synthetic event, so they lose nothing.

- **Some keys name events that are going away.** v27 removes `step.started`, `turn.completed`, and the `compaction.*` events, so those keys would name facts that no longer exist.
- **Dispatch is scattered:**
  - six type-filtered dispatch calls, run for every published event, deltas included;
  - allowed sets in several files, one of them duplicated, and one participant with no build-time check;
  - special cases for `step.started`;
  - each re-entry path choosing which event to rebuild.
- **Authors can't rely on the payload,** because it's typed `unknown`.

## Proposal

### The API

Each participant is one function per action. It receives a committed event and `ctx`, and returns its result, or nothing for no change. A dynamic resolver also declares how often it runs:

```ts
// agent/tools/catalog.ts
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  scope: "session",
  resolve: (_event, ctx) => ({ search: defineTool({/* … */}) }),
});
```

The rare resolver that needs two frequencies declares both and branches on the event:

```ts
// agent/agent.ts
export default defineAgent({
  model: defineDynamic({
    scope: ["session", "model"],
    resolve: (event, ctx) =>
      event.type === "session.started"
        ? modelForPlan(ctx.session.auth)
        : hasImages(ctx.messages)
          ? visionModel
          : undefined,
  }),
});
```

Memory providers keep two actions. Most do the same thing at both of their moments, so they don't branch:

```ts
export default defineMemoryProvider({
  // At the start of each turn, and after a compaction.
  recall: async (_event, ctx) => store.search(ctx.memory.scope, latestUserText(ctx.messages)),

  // After each completed turn, and before a compaction.
  capture: async (_event, ctx) => store.save(ctx.memory.scope, ctx.messages),
});
```

A provider that wants different behavior switches on the type. Each type it receives is exactly one moment:

```ts
export default defineMemoryProvider({
  async recall(event, ctx) {
    switch (event.type) {
      case "turn.started":
        return recallForTurn(ctx);
      case "context.settled": // a compaction just completed
        return restoreAfterCompaction(ctx);
    }
  },
  async capture(event, ctx) {
    switch (event.type) {
      case "turn.settled": // a turn just completed
        return captureTurn(ctx);
      case "context.started": // a compaction is about to start
        return captureBeforeCompaction(ctx);
    }
  },
});
```

- **`scope` is required.** A default of `"session"` would leave turn-level resolvers stale without saying so, and a default of `"turn"` would quietly run session resolvers every turn. One word up front avoids both.
- **`event` is typed to what the participant receives,** and narrows by `type`. On memory's `context.settled` branch, `event.data.kind` is literally `"compaction"`. `ctx` (`DynamicResolveContext`, or memory's context) is unchanged, and eve builds it lazily, so branching first costs little.
- **Restrictions are type errors.** A skill resolver that declares `scope: "model"` doesn't compile. `eve/skills` and the subagent form of `eve`'s `defineDynamic` get their own typed variants.
- **`recall` is required and `capture` is optional,** as today.
- **Guards from `eve/events`** (`isCompaction`, `isCompleted`, `hasKind`, `hasOutcome`) are there for hooks, channels, and view code. Participants rarely need them, because eve has already narrowed what they receive.

### What each participant receives

| Scope       | Receives                                    | Results last   | Accepted by                                                        |
| ----------- | ------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| `"session"` | `session.started`, again after a redeploy   | The session    | Dynamic model, tools, instructions, skills, connections, subagents |
| `"turn"`    | `turn.started`                              | The turn       | The same                                                           |
| `"model"`   | `model.requested`, for runs owned by a turn | One model call | Dynamic model and tools                                            |

Memory has no `scope`; eve fixes its moments:

| Memory function | Receives                                                                  |
| --------------- | ------------------------------------------------------------------------- |
| `recall`        | `turn.started`, and `context.settled` for completed compactions           |
| `capture`       | `turn.settled` for completed turns, and `context.started` for compactions |
| `tools`         | `turn.started`                                                            |

- **`model.requested`** lands in the commit that makes the next model call necessary: the turn's start, the last call result, an answer, steering, or a completed sign-in. Participants run after it, and `model.started` records the model they chose. It doesn't run again for provider retries inside one run, and a run that replaces an abandoned one reuses that run's decision.
- **Summary runs.** A compaction's summary run uses `compactionModel` if one is configured, otherwise the model the turn's current run chose. Between turns, the dynamic model runs on the summary run's `model.requested`, as manual compaction's synthetic `step.started` does today. Tool participants never see summary runs.
- **Redeploys re-run the session's start.** A newer deployment takes a session over only while it's idle. Before the next turn's participants run, eve calls every session-scoped participant again with the session's original `session.started`: a real event at its real position, re-run against the new code. The trigger is the revision check eve makes today (`VERCEL_DEPLOYMENT_ID`, or the compiled artifacts' key locally), so nothing new goes on the stream. Turn and model-call resolvers need nothing: the next turn or model call runs them on the new code anyway.
- **A fresh process on the same deployment isn't a redeploy.** It rebuilds code from recorded results without deciding them again.
- **Failed and cancelled turns** don't reach `capture`, as today. If providers ask, capturing them can come later as an explicit opt-in on the provider.
- **Framework work moves onto events too.** The skill and connection announcements and the framework connection tools run on `model.requested` as built-in participants, instead of as special cases on `step.started`.

### Why not keep the maps and filter them

An alternative keeps today's shape and has eve filter what reaches each key:

```ts
defineMemoryProvider({
  capture: {
    "turn.settled": captureTurn, // only completed turns arrive
    "context.started": captureBeforeCompaction, // only compactions arrive
  },
});
```

- **The event model condenses information into fewer types.** One terminal per entity carries the outcome as a value, and one family per operation carries the kind. That serves most readers: one fact to handle, closed outcome sets, generic handling, and older readers that stay correct when a kind is added. But a distinction that used to be a type is now data, and a key can only name a type.
- **So a filtered key hides what the event means.** `"turn.settled"` reads as every settled turn, and a reviewer would assume failed turns are captured. This repeats the problem this doc started with, moved from the event to its filter.
- **Making the filter visible means more technical types:** qualified keys that exist nowhere on the wire, such as `"turn.settled:completed"`, or refinements in handler types, such as `TurnSettled & {data: {outcome: "completed"}}`.
- **Filters on one type don't compose:** handling completed and failed turns differently would need two keys for one type.

Instead, an author who names an event gets every instance of it, as hooks and channels do. eve filters only where it defines the moment and names it as one: a resolver's `scope`, and memory's fixed moments, whose `event` types state the filter.

### What a handler returns

- **A result, or nothing.** Nothing means no change, and nothing is recorded.
- **A result lasts for the scope of the event it answered:** the session for `session.started`, the turn for `turn.started`, and one model call for `model.requested`. Persisted callback scopes stay `session`, `turn`, and `step`, with `"model"` stored as `step`, so a session that spans the deploy restores its locked tools.
- **Results are recorded as today,** in the same durable keys, so a restore reuses locked identities instead of resolving again against the current configuration. There's no `entry` field: a restore rebuilds code from recorded results using the original event, and a redeploy re-runs the original `session.started`. Both call the resolver again, which is why resolvers should stay idempotent. The docs already ask for that.

### One pipeline

```text
harness/participants/
  receives.ts   which events each scope and memory function receives, and how eve narrows them
  registry.ts   the bundle's participants, built once
  run.ts        runParticipants(commit, ctx): calls participants for each event they receive, in fact order, and records results
```

- **The step that writes a commit calls `runParticipants`** after the commit's observers. Progress never reaches participants.
- **One fixed order per event:** memory first, then the dynamic model, connections, subagents, tools, skills, and instructions, which is today's order. Today's failure rules stay; for example, a throwing `recall` on `turn.started` fails the turn before the model runs.
- **Restores reuse recorded results.** They call into the pipeline only to rebuild code, with the original event.

**Deleted:**

- `harness/session-machine/resolver-events.ts`, and its `modelId: "dynamic"` placeholder;
- the six type-filtered dispatch calls in `turn-event-handler.ts`;
- the memory type checks in `context/memory-event-lifecycle.ts`;
- the `step.started` skip and special cases in the model, tool, skill, and connection dispatchers;
- the `ALLOWED_DYNAMIC_*` sets in the runtime and the compiler, replaced by the table of what each participant receives.

### One ordering change

Today memory runs between the write and the hooks, while the dynamic resolvers run after the hooks. In the pipeline, every participant runs after the commit's observers. The difference isn't visible to hooks, because they never see model messages or memory results. The only effect: a hook that cancels the turn from `turn.started` now stops memory recall from running for a turn that won't call the model.

## Compatibility

Every dynamic resolver and memory provider changes shape, mechanically. It ships in the same release as the event break ([`session-event-lifecycle.md`](./session-event-lifecycle.md#compatibility-at-the-break)), so authors migrate once.

- **A codemod rewrites each map as a function:** `events: {a: f, b: g}` becomes `resolve(event, ctx)`, with a `scope` derived from the keys and a `switch` only when there are several. Memory's `recall` and `capture` maps become functions the same way. Of the 209 files that use `defineDynamic` today, 115 key `session.started`, 81 `turn.started`, and 20 `step.started`; only 10 use more than one key, so almost every resolver gets a single scope and no `switch`. Along the way it renames `step.started` to `model.requested`, memory's `compaction.requested` to `context.started`, `compaction.completed` to `context.settled`, and `turn.completed` to `turn.settled`, and drops the conditions eve now applies.
- **The old shape fails the build with the fix.** A `defineDynamic` with `events`, or a memory provider with maps, gets an error that points at the codemod. It's an error, not an alias, and it can be removed after a release or two.
- **Handler payloads become typed.** The first argument is `unknown` today.
- **Running sessions aren't affected.** Key names aren't persisted, and stored scope names stay as they are.
- **Extension contracts.** Retained epochs whose fixtures author `defineDynamic({ events })` are dropped with a reason: 57 for dynamic tools, 29 for instructions, 28 for skills, 9 for subagents, and 5 for connections. Each capability gets a new epoch.
- **Third-party extensions and memory providers** built against the old API break until they update.
- **In this repo,** the migration covers:
  - 51 e2e fixture files and 19 framework source files that use `defineDynamic`;
  - the file memory provider and two e2e memory fixtures;
  - 7 docs pages, two template files, `eve-code`, and one app fixture.

## Plan

Two PRs in the overall plan ([`session-event-lifecycle.md`](./session-event-lifecycle.md#phases)):

1. **On `main`, now: the pipeline behind today's API.** What each participant receives, the registry, and `runParticipants`, with today's maps adapted onto it internally. Dispatch moves onto it one participant at a time, with scenario tests pinning order and timing:
   - memory recall before the first model call;
   - dynamic model selection per model call, and for a manual compaction;
   - the refresh after a redeploy;
   - restoring a parked step's tools.

   It changes nothing for authors. It touches `execution/session/turn-step.ts`, `harness/model-call/run.ts`, and `harness/hitl/intake.ts`, which HumanInput (#4342–#4344) also changes, so whichever lands second rebases rather than waiting.

2. **On the integration branch, after the conversation slice: the API.** The single function with `scope`, memory's moments, typed entry points, the `eve/events` export, the build errors, the codemod, the repo migration, and the docs. Its tests come with the rest of the v27 suite at the end of the break.

**Size:** a small net reduction, not measured. The dispatch and synthetic-event code it removes is a few hundred lines across `turn-event-handler.ts` (140), `resolver-events.ts` (29), `memory-event-lifecycle.ts` (76), and the filtering parts of the six `context/dynamic-*-lifecycle.ts` files. The pipeline adds back something smaller.

## Open questions

1. **Is the ordering change acceptable?** The alternative is for the turn step to run memory between the write and the hooks, as today. That keeps a second, special-cased path into the pipeline.
