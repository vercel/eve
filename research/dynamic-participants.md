---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-08"
---

# Dynamic participants

Read on `main` at `285d4e09b`, with the redeploy and compaction paths re-checked at `bf82cfa88`, and the resolver context and handlers' `ctx` reads re-checked at `d43a449a7`. Nothing was prototyped.

## Summary

Dynamic resolvers (`defineDynamic({ events })`) and memory providers key their handlers on stream event names: `session.started`, `turn.started`, `step.started`, `compaction.requested`, `compaction.completed`, and `turn.completed`. But they don't actually observe the stream. The state machine builds fake, unpublished events to drive them: replays of events published earlier, and previews of events about to be published.

That happens for two reasons:

- **One moment has no event.** Resolvers that pick the model and tools must run before each model call, but the event that records the call, `step.started`, already carries the chosen model.
- **Re-runs use hand-built events.** Restores, the refresh after a redeploy, and parked steps re-run resolvers on events rebuilt by hand, with approximate fields, instead of the events that were actually published.

The keys also fix when a resolver runs, not what its answer depends on. A resolver keyed on `session.started` that reads the caller keeps the first caller's answer for the whole session. One keyed on `step.started` runs in full before every model call, even when its answer can't change.

This doc proposes that participants stop consuming events and decide from session state instead:

- **A dynamic resolver declares what its decision depends on.** `select(view, ctx)` reads a small value from the session view, and `resolve(selected)` turns it into a result. eve calls `resolve` only when the selection changes.
- **eve owns when each capability can change:** the model and tools before each model call, and everything else at the start of each turn. [`session-event-lifecycle.md`](./session-event-lifecycle.md) adds `model.requested`, so the view has a position before the model is chosen.
- **Memory keeps fixed moments,** named by eve instead of by event types: `recall(view, ctx)` and `capture(view, ctx)`, with `ctx.moment` telling them apart.
- **Decisions are recorded with their selection.** Restores rebuild code from the recorded selection, and redeploys re-resolve at the next change point, so nothing replays or rebuilds an event.
- Participants run in one pipeline.

The pipeline can land first. The new API ships with the event break, so authors migrate once. After it, participants name no events, so later catalog changes don't reach them.

## Participants versus observers

|                  | Observers                                    | Participants                                                                            |
| ---------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Who              | Hooks, channel handlers                      | Dynamic model, tools, instructions, skills, connections, subagents; memory              |
| Run on           | Committed events                             | Change points eve defines, after the commit that reaches them and before dependent work |
| Can change state | No; they react to what was decided           | Yes; their results feed the model call, and are recorded so restores reuse them         |
| Receive          | The event, plus `ctx.view`                   | The view pinned at the change point, and no event                                       |
| Unknown values   | Branch on them, with a fallback              | Never see events; selectors over the view handle open kinds                             |
| Shape            | A handler per event type, plus `*` for hooks | `select` and `resolve` for dynamic resolvers; one function per action for memory        |

The rule for authors: **observers react to what happened; participants decide from where things stand.**

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

- **The names promise stream facts that aren't there.** Model selection shows it most clearly:

  ```text
  today     build step.started {modelId: "dynamic"}   unpublished, no meta
            → the resolver picks the model
            → publish step.started {modelId: chosen}  a different event
            → provider call

  proposed  commit model.requested {runId, owner}     published at position N
            → each model and tool participant selects from the view at N
            → resolve runs only where the selection changed
            → commit model.started {runId, modelId}   the decision lands on the next fact
            → provider call
  ```

  - **Today the resolver's input depends on its own answer,** so `modelId` is a placeholder and the event can't be published first. The view at N holds nothing the participants decide, so it's complete before they run.
  - **Re-runs need no event.** Restores call `resolve` with the recorded selection, and a redeploy re-resolves at the next change point. Neither rebuilds `session.started`, `turn.started`, or `step.started` by hand.
  - **Two things do move earlier.** Readers see a model call coming before the model is chosen, which lets clients show "preparing" and evals time resolution. Hooks see `model.requested` before participants run, since participants run after a commit's observers; hooks never saw the synthetic event, so they lose nothing.

- **Keys fix when a resolver runs, not what it depends on:**
  - The team playbook example in `docs/guides/dynamic-capabilities.md` reads `auth.current` on `session.started`, so the first caller's team applies for the whole session. In a shared session, the next caller gets the wrong playbook, and nothing in the definition says so.
  - A `step.started` resolver runs in full, async work included, before every model call, even when its answer can't change.
- **Some keys name events that are going away.** v27 removes `step.started`, `turn.completed`, and the `compaction.*` events, so those keys would name facts that no longer exist.
- **Dispatch is scattered:**
  - six type-filtered dispatch calls, run for every published event, deltas included;
  - allowed sets in several files, one of them duplicated, and one participant with no build-time check;
  - special cases for `step.started`;
  - each re-entry path choosing which event to rebuild.
- **Authors can't rely on the payload,** because it's typed `unknown`.

## Proposal

### The API

A dynamic resolver says what its decision depends on, then turns that into a result:

```ts
// agent/skills/team_playbook.ts
import { defineDynamic, defineSkill } from "eve/skills";
import { PLAYBOOKS } from "../lib/playbooks";

export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.team ?? null,
  resolve: (team) => {
    const markdown = team ? PLAYBOOKS[team] : undefined;
    return markdown ? defineSkill({ markdown }) : null;
  },
});
```

When a caller from another team takes a turn, the selection changes and the playbook is resolved again at that turn's start. A resolver whose answer doesn't depend on the session omits `select`:

```ts
// agent/tools/catalog.ts
import { defineDynamic } from "eve/tools";
import { loadCatalogTools } from "../lib/catalog";

export default defineDynamic({
  resolve: () => loadCatalogTools(),
});
```

One selection can combine inputs that change at different rates, which replaces a resolver keyed on two events:

```ts
// agent/agent.ts
export default defineAgent({
  model: defineDynamic({
    select: (_view, ctx) => ({
      pro: ctx.session.auth.current?.attributes.plan === "pro",
      images: hasImages(ctx.messages),
    }),
    resolve: ({ pro, images }) => (images ? visionModel : pro ? proModel : defaultModel),
  }),
});
```

Expensive work belongs in `resolve`. Selecting the turn redoes it once per turn:

```ts
// agent/tools/orders.ts
import { activeTurn } from "eve/events";
import { defineDynamic } from "eve/tools";
import { checkStock, placeOrder } from "../lib/order-tools";
import { fetchWarehouseStatus } from "../lib/warehouse";

export default defineDynamic({
  select: (view) => activeTurn(view)?.turnId ?? null,
  async resolve(_turnId, { abortSignal }) {
    const status = await fetchWarehouseStatus({ signal: abortSignal });
    return status.acceptingOrders ? { checkStock, placeOrder } : { checkStock };
  },
});
```

Memory providers keep two actions. Most do the same thing at both of their moments, so they don't branch:

```ts
export default defineMemoryProvider({
  // At the start of each turn, and after a compaction.
  recall: async (_view, ctx) => store.search(ctx.memory.scope, latestUserText(ctx.messages)),

  // After each completed turn, and before a compaction.
  capture: async (_view, ctx) => store.save(ctx.memory.scope, ctx.messages),
});
```

A provider that wants different behavior switches on `ctx.moment`:

```ts
export default defineMemoryProvider({
  async recall(_view, ctx) {
    switch (ctx.moment) {
      case "turn": // a turn is starting
        return recallForTurn(ctx);
      case "compaction": // a compaction just completed
        return restoreAfterCompaction(ctx);
    }
  },
  async capture(_view, ctx) {
    switch (ctx.moment) {
      case "turn": // a turn just completed
        return captureTurn(ctx);
      case "compaction": // a compaction is about to start
        return captureBeforeCompaction(ctx);
    }
  },
});
```

- **`select` declares the inputs.** It's synchronous and deterministic, and returns a small JSON value under a size cap. An async `select` is a type error, and an oversized or non-JSON selection fails with an error that names the participant. A clock read is the usual mistake, so development mode evaluates `select` twice to catch it.
- **`resolve` receives only the selection,** plus services such as `abortSignal`. It can't read the view, so it can't depend on session state it didn't select. Data from outside eve needs an explicit dependency, such as the turn.
- **Omitting `select` means a constant selection.** eve resolves once and reuses the decision until a redeploy.
- **`view` is the `SessionView` that observers get as `ctx.view`,** pinned at the change point, in operational retention ([tables, selectors, and retention](./session-event-lifecycle.md#tables-selectors-and-retention)). It keeps the open turn, open work, and aggregates such as usage, and prunes closed rows, so a selection reads what's open or aggregated. `ctx` is today's `DynamicResolveContext`, narrowed per kind as today: connections don't receive messages.
- **Select the fact, not the data.** `hasImages(ctx.messages)` changes once, while `ctx.messages.length` changes at every model call and makes `resolve` run every time. Development mode warns when a participant re-resolves at most of its change points.
- **There's no timing to get wrong.** A skill has no model-call change point, so the skill keyed on `step.started` that compiles and never runs can't be written. The entry points per kind (`eve/tools`, `eve/skills`, and so on) type `ctx` and the result, not timing.
- **Memory isn't memoized.** Recall and capture are meant to run at every moment, so they have no `select`. `ctx.moment` is a closed set: a new moment reaches providers only if eve adds it. `recall` is required and `capture` is optional, as today.

### When participants run

| Change point | Reached by                                                   | Participants                                         |
| ------------ | ------------------------------------------------------------ | ---------------------------------------------------- |
| Turn start   | The commit with `turn.started`                               | Dynamic instructions, skills, connections, subagents |
| Model call   | Each commit with `model.requested` for a run owned by a turn | Dynamic model and tools                              |

Memory has no `select`; eve fixes its moments:

| Memory function | `ctx.moment`   | Runs                                                 |
| --------------- | -------------- | ---------------------------------------------------- |
| `recall`        | `"turn"`       | At each turn start                                   |
| `recall`        | `"compaction"` | After a compaction completes (`context.settled`)     |
| `capture`       | `"turn"`       | After a turn completes (`turn.settled`, `completed`) |
| `capture`       | `"compaction"` | Before a compaction starts (`context.started`)       |
| `tools`         | none           | At each turn start                                   |

- **At each change point, eve evaluates `select` for each participant there.** It calls `resolve` only when the selection differs from the current decision's, or that decision came from an older revision. Work started at the change point uses the decisions current then. View changes between change points, including every streamed delta, call nothing.
- **`model.requested`** lands in the commit that makes the next model call necessary: the turn's start, the last call result, an answer, steering, or a completed sign-in. Participants run after it, and `model.started` records the model they chose. Provider retries inside one run aren't change points, and a run that replaces an abandoned one reuses that run's decisions.
- **There's no session change point.** A resolver whose selection never changes resolves at its first change point and keeps that decision.
- **Summary runs.** A compaction's summary run uses `compactionModel` if one is configured, otherwise the model the turn's current run chose. Between turns, the dynamic model is evaluated at the summary run's `model.requested`, as manual compaction's synthetic `step.started` does today. Tool participants never see summary runs.
- **Redeploys re-resolve at the next turn.** A newer deployment takes a session over only while it's idle. Decisions made under the older revision are stale, so the next turn's change points call `resolve` again, even for unchanged selections. The trigger is the revision check eve makes today (`VERCEL_DEPLOYMENT_ID`, or the compiled artifacts' key locally), so nothing new goes on the stream.
- **A fresh process on the same deployment isn't a redeploy.** It rebuilds code from recorded decisions without deciding them again.
- **Failed and cancelled turns** don't reach `capture`, as today. If providers ask, capturing them can come later as an explicit opt-in on the provider.
- **Framework work moves onto change points too.** The skill and connection announcements and the framework connection tools become built-in participants at the model-call change point, instead of special cases on `step.started`.

### Why not `scope`, events, or tracked reads

- **`scope`, from an earlier draft of this doc,** declared whether a resolver ran per session, per turn, or per model call. That one word answered four questions: when the resolver runs, how long its result lasts, which result wins when scopes layer (`scope: ["session", "model"]`), and which capabilities may change mid-turn. Only the first belongs to the author, and it still hid the dependency: a session-scoped resolver that reads the caller goes stale when the caller changes. With `select`, the dependency is the declaration, and eve owns the other three.
- **Event keys filtered by eve** would keep today's shape, with eve narrowing what reaches each key: `capture: {"turn.settled": f}` would receive only completed turns. The event model condenses outcomes and kinds into values on fewer types, so a filtered key hides what the event means: `"turn.settled"` reads as every settled turn. Making the filter visible needs keys that exist nowhere on the wire, such as `"turn.settled:completed"`. And keys tie participants to the catalog.
- **Tracking reads automatically,** as signals do, would re-run a resolver whenever something it read changed. It misses reads of `ctx` and of data outside eve, it's hard to record durably, and it hides why something re-resolved. Skipping `select` when nothing it read has changed could come later as an optimization, not as the contract.
- **The split has precedent.** [Reselect](https://redux.js.org/reselect/api/development-only-checks) separates input selectors from a result function, and runs the same development checks. [TanStack Query](https://tanstack.com/query/latest/docs/eslint/exhaustive-deps) requires a query key to hold everything the fetch depends on. [Temporal](https://docs.temporal.io/develop/typescript/workflows/basics) keeps workflow code deterministic and records activity results for replay, as `select` and recorded decisions do here.

### What `resolve` returns

- **A result, or nothing.** Nothing keeps the current decision, and eve records that this selection was checked, so a failing source isn't retried at every change point until the selection changes. A first resolution has nothing to keep: optional capabilities contribute nothing, and a model resolver must return a model.
- **Throwing never keeps the previous decision.** Each capability's failure rule applies as today: for example, a model failure fails the turn, a failing subagent is logged and omitted, and system instructions contribute nothing rather than leaking an older value.
- **Equal results change nothing.** eve compares results by their serialized declarations: names, descriptions, schemas, and durable callback references with their captures. A re-resolve that returns the same tools doesn't re-announce skills or connections or change the provider request. An unstable value, such as a timestamp in a description, makes every re-resolve a change.
- **A user-role instruction result is appended to history each time a new selection resolves to it.** A resolver that selects the turn appends every turn, as `turn.started` does today. An equal result after a redeploy isn't appended again.
- **Decisions are recorded per participant:** the selection, the revision, the view position, and the result. The selection stays in the session's private execution state, never on the stream, because it often holds auth attributes. A restore calls `resolve` with the recorded selection to rebuild code, and keeps the recorded identities instead of deciding again. That's why resolvers should stay idempotent, which the docs already ask.
- **Calls keep the decision they started under.** A parked call's tools come from the decision recorded at its model call, even if the current decision has changed since. This replaces the parked-step `step.started` rebuild.

### One pipeline

```text
harness/participants/
  change-points.ts  which participants each change point runs, and memory's moments
  registry.ts       the bundle's participants, built once
  run.ts            runParticipants(commit, ctx): evaluates selections at the change points the commit reaches, resolves what changed, and records decisions
```

- **The step that writes a commit calls `runParticipants`** after the commit's observers. Progress never reaches participants.
- **One fixed order:** memory first, then the dynamic model, connections, subagents, tools, skills, and instructions, which is today's order. A participant may select outputs of participants earlier in the order through `ctx`, such as a subagent selecting `ctx.model`, and never later ones, so there's no dependency graph to solve.
- **Today's failure rules stay.** For example, a throwing `recall` at turn start fails the turn before the model runs.
- **Restores reuse recorded decisions.** They call into the pipeline only to rebuild code from recorded selections.

**Deleted:**

- `harness/session-machine/resolver-events.ts`, and its `modelId: "dynamic"` placeholder;
- the six type-filtered dispatch calls in `turn-event-handler.ts`;
- the memory type checks in `context/memory-event-lifecycle.ts`;
- the `step.started` skip and special cases in the model, tool, skill, and connection dispatchers;
- the `ALLOWED_DYNAMIC_*` sets in the runtime and the compiler, replaced by the table of change points.

### One ordering change

Today memory runs between the write and the hooks, while the dynamic resolvers run after the hooks. In the pipeline, every participant runs after the commit's observers. The difference isn't visible to hooks, because they never see model messages or memory results. The only effect: a hook that cancels the turn from `turn.started` now stops memory recall from running for a turn that won't call the model.

## Compatibility

Every dynamic resolver and memory provider changes shape. It ships in the same release as the event break ([`session-event-lifecycle.md`](./session-event-lifecycle.md#compatibility-at-the-break)), so authors migrate once.

- **A codemod keeps today's timing.** Each key maps to the selection that resolves exactly as often: `session.started` to no `select`, `turn.started` to the turn's ID, and `step.started` to the requested run's ID.
  - Handlers that read nothing from `ctx` convert mechanically.
  - Of the roughly 210 files that use `defineDynamic`, about half read `ctx` in a handler (a rough grep, not a parse). The codemod moves simple reads into the selection. For example, `ctx.session.auth.current` in a `session.started` handler becomes a selection of `auth.initiator`, which is the same caller at session start.
  - It leaves a TODO where it can't, chiefly the dozen or so files that read `ctx.messages`, which need to select a fact instead.
  - Authors can then narrow selections by hand, for example a turn resolver that depends only on the caller. The codemod can't know what data outside eve a resolver depends on.
- **Memory's maps become `recall` and `capture` functions,** with a `switch` on `ctx.moment` only when a map has several keys: `turn.started` and `turn.completed` become `"turn"`, and `compaction.requested` and `compaction.completed` become `"compaction"`. The codemod drops the conditions eve now applies.
- **The old shape fails the build with the fix.** A `defineDynamic` with `events`, or a memory provider with maps, gets an error that points at the codemod. It's an error, not an alias, and it can be removed after a release or two.
- **The untyped payload goes away.** Participants receive the typed view instead of an `unknown` event.
- **Running sessions don't cross the break,** so recorded decisions can change shape there. The pipeline PR on `main` keeps today's durable keys.
- **Extension contracts.** Retained epochs whose fixtures author `defineDynamic({ events })` are dropped with a reason: 57 for dynamic tools, 29 for instructions, 28 for skills, 9 for subagents, and 5 for connections. Each capability gets a new epoch.
- **Third-party extensions and memory providers** built against the old API break until they update.
- **In this repo,** the migration covers:
  - 51 e2e fixture files and 19 framework source files that use `defineDynamic`;
  - the file memory provider and two e2e memory fixtures;
  - 7 docs pages, two template files, `eve-code`, and one app fixture.

## Plan

Two PRs in the overall plan ([`session-event-lifecycle.md`](./session-event-lifecycle.md#phases)):

1. **On `main`, now: the pipeline behind today's API.** The change points, the registry, and `runParticipants`, with today's maps adapted internally onto the selections the codemod would write: none for `session.started`, the turn for `turn.started`, and the run for `step.started`. Dispatch moves onto it one participant at a time, with scenario tests pinning order and timing:
   - memory recall before the first model call;
   - dynamic model selection per model call, and for a manual compaction;
   - the refresh after a redeploy;
   - restoring a parked step's tools from its recorded decision.

   It changes nothing for authors. It touches `execution/session/turn-step.ts`, `harness/model-call/run.ts`, and `harness/hitl/intake.ts`, which HumanInput (#4342–#4344) also changes, so whichever lands second rebases rather than waiting.

2. **On the integration branch, after the conversation slice: the API.** `select` and `resolve`, memory's moments, recorded selections, the development checks, typed entry points, the `eve/events` export with its selectors, the build errors, the codemod, the repo migration, and the docs. Its tests come with the rest of the v27 suite at the end of the break.

**Size:** a small net reduction, not measured. The dispatch and synthetic-event code it removes is a few hundred lines across `turn-event-handler.ts` (140), `resolver-events.ts` (29), `memory-event-lifecycle.ts` (76), and the filtering parts of the six `context/dynamic-*-lifecycle.ts` files. The pipeline, selection comparison, and recording add back something smaller.

## Open questions

1. **Is the ordering change acceptable?** The alternative is for the turn step to run memory between the write and the hooks, as today. That keeps a second, special-cased path into the pipeline.
2. **Revisions per participant.** A redeploy re-resolves every participant in every session that takes it over, so every external source gets called at once after a deploy. A fingerprint per participant module, instead of the deployment ID, would re-resolve only participants whose code changed. Can the bundle provide a stable one?
3. **Mid-turn tool changes and prompt caching.** Tools can change at any model call. [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) invalidates the whole cache when tool definitions change, and [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) recommends stable tools with `allowed_tools`. Should the harness keep the decision separate from the request, removing tools only at turn start and masking or appending mid-turn where a provider supports it?
4. **History beyond the operational view.** `ctx.view` prunes closed calls and turns, so a selection can't count earlier deploys or failures. Should participants be able to declare folded aggregates that survive pruning, like `extendConversation` does for clients, or should they derive such facts from `ctx.messages`?
5. **Periodic refresh.** Selecting the turn refreshes every turn. "At most every ten minutes" needs a committed time in the view, such as the `at` of the turn's start commit, and rows don't carry one today.
