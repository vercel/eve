---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-09"
---

# Session reactions

Read on `main` at `8c55ea7c1`. The runtime was modeled in a standalone prototype: a runner, the authoring sugar, and a toy session, about 700 lines with 12 scenario tests, microbenchmarks, and two small simulations. Nothing in eve was changed. This doc replaces `dynamic-participants.md` and keeps its plan.

## Summary

Four authoring surfaces react to a session: dynamic resolvers (six kinds), memory providers, hooks, and channels. About a dozen built-in behaviors, such as skill announcements and the compaction trigger, do the same. Each has its own dispatch, timing rules, recording, and replay:

- **Participants run on events that never happened.** The state machine hand-builds `session.started`, `turn.started`, and `step.started` to drive resolvers before a model call, on restores, and after redeploys.
- **Keys fix when, not what.** A resolver keyed on `session.started` that reads the caller keeps the first caller's answer for the whole session.
- **The same machinery exists many times.** About 3,300 lines of per-kind lifecycles, loaders, normalizers, and memory code each write their own durable keys, revision refresh, validation, and failure handling.
- **It costs work.** Every event a turn publishes, each streamed delta included, waits on eight dispatchers in turn (memory, hooks, and six resolver kinds), and connection resolvers re-run before every model call.

This doc proposes one primitive underneath all of them, a **reaction**:

```text
select(view, ctx)    what it depends on: synchronous, deterministic JSON
run(selected, ctx)   what it does: returns a list of entries, and may do I/O
```

`run` is called after its selection changes, and before anything it declared is next read. Nothing else triggers it.

- **An entry is a declaration or a request.**
  - A declaration, such as a tool, a skill, a model, context, or plain data, is part of the reaction's current contribution. eve records the whole list as the reaction's slot, so anything missing from the next list is gone.
  - A request, such as "compact now" or "continue", goes to the session machine once. The machine decides the facts.
- **Facts aren't a separate input.** A selection over the view notices them, so authors never declare when a reaction runs, where its output goes, or which events it subscribes to.
- **Every surface is sugar.**
  - `defineDynamic` wraps exactly what a file would export, and its result becomes declarations named by the file.
  - Memory recall and tools are dynamic declarations, and capture keeps a cursor as data.
  - Hooks and channels gain a `select`/`onChange` form beside event keys.
  - eve's built-ins use the same primitive.
  - `defineReaction` stays internal until it has its own doc.
- **It enables behaviors that have no home today:** modes that several capabilities follow, context added mid-turn when a condition becomes true, one policy across every call, state derived from commits exactly once, follow-up turns the agent starts itself, and timers per session.
- **It's the shape the session-log sketch already has.** A reaction's slot is the sketch's `capabilities.changed` entry, kept in the checkpoint until there's a log. A full log isn't needed.
- **It's cheap.** In the prototype, 20 unchanged reactions cost about 7 µs per model call. It removes today's per-delta dispatch and per-call connection replays. The costs to manage are selections that scan history, tool changes mid-turn, and re-runs after deploys ([Performance](#performance)).

The plan is unchanged. The pipeline lands on `main` behind today's API, the conversation slice moves it onto the v27 commits that announce each use, and the API is the last PR of the break. The runner is how the pipeline is built.

## The model in one picture

```text
inputs ──▶ machine ──▶ commit {facts, entries} ──▶ stream (facts) · checkpoint (entries)
              ▲               │ fold
              │               ▼
              │       SessionView @ position
              │               │ select → unchanged? reuse : run → [entries]
              │        ┌──────┴──────────────┐
              └── requests              declarations ──▶ the reaction's slot, folded into the view
             (compact, continue,       (tools, a model, skills,
              steer, open, cancel)      context, data)
```

- **Facts come only from the machine.** Reactions return entries:
  - declarations, which fold into the view;
  - requests, which the machine turns into facts or refuses.

  Effects, such as posting a message, happen inside `run`.

- **A reaction's input is always a selection.** Facts aren't a separate input: a selection over the view notices them ([Facts are selections too](#facts-are-selections-too)).
- **What a reaction returns decides everything else:** when eve calls it, what's recorded, and what a failure means. The split that used to be "participants" and "observers" comes down to this:

|                  | Declares something eve reads later                                                            | Declares data, requests something, or returns nothing  |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Called           | Before anything it declared is next read                                                      | Right after the commit that changed its selection      |
| Recorded         | Its slot and a digest of its selection, plus the full selection if a declaration carries code | Its slot, if it has one, and a digest of its selection |
| Retry or restore | The slot is reused; `run` re-runs only to rebuild code                                        | `run` repeats at most once, for the last commit        |
| Failure          | Depends on the kind: fail the turn, omit, or contribute nothing                               | Logged; the turn continues                             |

## Today

| Surface                                                            | Code                                                                                                   | When it runs                                                                   | Where results live                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Dynamic tools, model, skills, instructions, connections, subagents | Six `context/dynamic-*-lifecycle.ts` files (1,683 lines), per-kind loaders (380) and normalizers (693) | Event keys `session.started`, `turn.started`, `step.started`, allowed per kind | Session, turn, and step keys per kind. Connections nowhere, so they re-run |
| Memory                                                             | `context/memory-lifecycle.ts` (522), `memory-event-lifecycle.ts` (76)                                  | Four event keys                                                                | Step-local prepare and drain keys; session state                           |
| Hooks and channels                                                 | `public/definitions/`, the publisher                                                                   | Every event they key; `*` hooks also get progress                              | Nothing                                                                    |
| Built-ins                                                          | Spread across `harness/` and `execution/`                                                              | Special cases                                                                  | Ad hoc keys                                                                |

<details>
<summary>What that costs, with references</summary>

- **Synthetic events.** `harness/session-machine/resolver-events.ts` builds events for:
  - model selection (`model-call/run.ts` and `compaction/step.ts`), whose preview carries `modelId: "dynamic"`;
  - the redeploy refresh and callback rebind (`execution/session/turn-step.ts`);
  - connection rehydration (`execution/dynamic-connections.ts`);
  - parked-step restores (`hitl/intake.ts`).
- **Per-event dispatch.** For every event the turn publishes, deltas included, `turn-event-handler.ts` awaits memory, then hooks, then the model, connections, subagents, tools, skills, and instructions.
- **Per-call replays.** Before every model call, `turn-step.ts` calls `dynamicConnections.rehydrate`. That sends a hand-built `session.started` and `turn.started` to every connection resolver, so any I/O in them runs once per model call.
- **Duplicated machinery:**
  - durable keys per scope: 3 copies, plus 2 inline variants;
  - revision refresh: 2 copies with separate keys, set to the same value;
  - name qualification and collision checks: 3 copies each;
  - allowed-event sets: in all six files, one duplicated in the compiler;
  - settle-and-log: 5 copies, each with a different failure rule.
- **Context keys.** About 30 of the 78 context keys in non-test source belong to participants. Seven are step-local channels between the harness and a participant: prepare, then drain.
- **Special cases that are reactions in disguise:**
  - skill and connection announcements;
  - the tasks and pending-approval notes;
  - framework connection tools;
  - the compaction trigger and memory canonicalization;
  - the auto model;
  - the continuation token on `session.waiting`;
  - relay forwarding and task cards.
- **Dead code in the copies.** Clearing durable callbacks on `session.completed` (`dynamic-tool-lifecycle.ts:540`) appears unreachable, because the terminal publish runs no handlers. This is inferred, not tested.

</details>

## The primitive

### `select` and `run`

```ts
interface Reaction<S extends Json> {
  select?(view: SessionView, ctx: SelectContext): S;
  run(selected: S, ctx: RunContext): Entry[] | typeof KEEP | Promise<Entry[] | typeof KEEP>;
}
```

That's the whole primitive. **`run` is called after its selection changes, and before anything it declared is next read.** Nothing else triggers it.

- **`select` declares the inputs.**
  - It's synchronous and deterministic, and returns JSON.
  - Omitting it means a constant selection, so `run` runs once.
  - Development mode evaluates it twice to catch clock reads.
  - A `select` that throws, returns something that isn't JSON, or fails the double evaluation is treated like `run` throwing: its declarations are withdrawn and each kind's failure rule applies. eve logs it once per reaction until `select` succeeds again, and development mode surfaces it at the first evaluation, since the build can't run it.
- **`run` gets the selection, not the view,** so it can't depend on state it didn't select. Its context adds:
  - services such as `abortSignal`;
  - `ctx.previous`, its own slot, which is how cursors and counters work;
  - `ctx.facts`, the facts since its previous evaluation, for reactions called right after each commit.
- **`KEEP` keeps the current slot** and records that the selection was checked. Public sugar spells it `undefined`.
- **The reaction's ID comes from its file path,** like every other eve name.

### When `run` is called

The rule is the one above: after the selection changes, and before anything the reaction declared is next read. Authors never choose the moment. eve does, from when each kind of entry is read ([Entries](#entries)):

- **eve may wait until a declaration is needed.** Tools and a model are read at the next model call; skills, instructions, connections, and subagents at the next turn. Waiting can't change the answer, because `run` sees only the selection. It only saves runs, outside fetches made before they're needed, and I/O on commits that don't need it.
  - A prototype simulation of one turn, where a `deployed` selection flips between uses, gave the same answer at all four uses either way. Calling `run` after every change took 6 runs; waiting until use took 2.
- **Anything else is called right after the commit that changed its selection.** Data can be read by anything at any time, a request is for the machine's next decision, and a reaction that declares nothing has no later read: its timing is the behavior.
- **"Before the next read" is still "after a commit".** The v27 catalog commits a fact at each moment eve needs an answer, which is why `model.requested` exists. A commit's reactions finish before the next commit, so the machine reads their declarations when it writes the next one, such as `model.started`.
- **There's no session moment.** A reaction whose selection never changes runs at its first evaluation and keeps its slot.
- **Summary runs** follow today's plan:
  - the summary uses `compactionModel` if one is configured, otherwise the turn's model;
  - between turns, the dynamic model is evaluated at the summary run's `model.requested`;
  - tool reactions never see summary runs.

### Facts are selections too

The view keeps, for each fact type, the position of its latest occurrence. It's a tiny fold of about 30 numbers. A new fact of a type is then an ordinary change in a selection:

```ts
// An audit hook as a plain reaction.
defineReaction({
  select: (view) => view.latest["call.settled"] ?? null,
  run: (_position, ctx) => {
    for (const fact of ctx.facts) if (fact.type === "call.settled") audit.write(fact);
    return [];
  },
});
```

- **Select an identity, not a count.** A prototype simulation audited `call.settled` across six commits, one of which settled two calls:
  - selecting the count of matching facts missed a settle in the very next commit, because two commits with one settle each look identical;
  - selecting the latest position caught all five.
- **Hook `events` maps and channel handlers are typed sugar for this.** eve can recognize the sugar and index reactions by fact type, which is an optimization only.
- **Filtered facts check their guard in `run`,** for example only completed turns, or only compactions.
- **Declarations that eve reads later don't depend on `ctx.facts`.** eve may wait to call them, so they would miss facts in between. A declaration that depends on what happened selects an aggregate instead, such as `view.succeeded.deploy`.
- **Restores don't fire again.** The latest positions are in the view, so a fresh process computes the same selections from its checkpoint.

### Entries

`run` returns a list of entries of two kinds:

| Kind                     | Examples                                                                    | Semantics                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declarations, with a key | Tools, skills, instructions, connections, subagents, a model, context, data | The list is the reaction's complete current contribution, recorded as its slot. A new list replaces the old one, so anything missing is withdrawn. Returning `[]` withdraws everything |
| Requests, one-shot       | Compact, continue, steer, open an interaction, start a task, cancel         | Consumed once by the machine, which decides the facts and can refuse ([Requests](#requests))                                                                                           |

Each kind of declaration is read by eve's code for that kind, at its own moment:

| Declaration                            | Read by, and when                                                                                       | If `run` throws                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| A model                                | The next model call                                                                                     | Fails the turn                                      |
| Tools (`defineTool` values)            | Every model call: validated, named, and merged across slots                                             | Omitted and logged                                  |
| Skills, subagents                      | Captured at turn start, for the turn                                                                    | Omitted and logged                                  |
| Instructions                           | System role: replaced per slot. User role: appended to context each time a new selection resolves to it | Contributes nothing, and never keeps an older value |
| Connections                            | Captured at turn start, for the turn                                                                    | Parks the session, as today                         |
| Context (recall, announcements, notes) | Every model call                                                                                        | The surface's rule; recall fails the turn           |
| Data                                   | Other reactions and selectors, through the slot                                                         | Logged                                              |

- **A declaration's key is its name, scoped by kind.** `defineDynamic` derives it from the file path or a map key, so authors rarely write one. Only the base layer writes keys, because an entry has no file of its own. Two reactions declaring the same name is an error, as today.
- **One reaction can declare several kinds, in order.** Tools, a skill, and instructions from one function each apply when their kind is read.
- **Slots are private and live in the view,** keyed by the reaction's ID. Later reactions read earlier slots through `select`, with no special mechanism. That's how a subagent follows the model, or how tools follow a mode.
- **There are no delta entries.** The whole list replaces the slot, so withdrawal is implicit, the way React's render returns the full tree and Kubernetes takes a desired spec. A slot is the session-log sketch's `capabilities.changed` entry, and context is its `contribution.recorded` ([`session-event-lifecycle.md`](./session-event-lifecycle.md#toward-a-session-log)).
- **Throwing withdraws your declarations; `KEEP` keeps them.** The code that reads each kind decides what absence means, as the table shows.
- **The per-kind logic that's genuinely essential lives with the declaration kinds:**
  - tool naming and durable callbacks;
  - skill sandbox sync;
  - connection sign-in entries;
  - the rule that a subagent needs a description.

### Requests

A request asks the machine to:

- **continue** with a follow-up turn;
- **steer** the running turn with a note;
- **compact** the context;
- **open** an interaction;
- **start** a task or child session;
- **cancel** the turn, which is today's `ctx.cancel()` and the only request extension code can make now.

Four rules apply to every request:

- **Reactions never emit facts.** "Compact now" is a request, and the machine commits `context.started`. That keeps the machine the only writer of facts, as in Event Modeling's chain of processor, command, and decider.
- **The machine can refuse,** for example after the session has closed.
- **Requests can't loop.** A request is issued only when `run` runs, which only happens when the selection changes. A compaction trigger that stays over its threshold doesn't ask again. Continuations and started work also have caps per delivery.
- **Authority is explicit:** a turn a reaction starts carries `cause: {reaction}` and the agent's own principal, never the caller's.

### Recording

Each time eve calls a reaction:

1. Evaluate `select` against the view after the commit.
2. If the selection's digest and the code revision match the slot, reuse it.
3. Otherwise call `run`.
4. Update the slot. The update is `checked` when `run` returns `KEEP` or a list equal to the slot, and `decided` otherwise. Only `decided` changes what readers see. Requests go to the machine either way.

What's stored depends on what the reaction declares:

| The reaction declares                                                           | eve stores                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Declarations without code: a model, skill markdown, instructions, context, data | The slot and a digest of the selection                                                    |
| Declarations with code: tools, connections with token callbacks, memory tools   | The slot and the full selection, which a restore passes back to `run` to rebuild the code |
| Nothing                                                                         | A digest of the selection                                                                 |

- **Only full selections are capped,** because only they're stored. Elsewhere a large selection costs CPU, not storage, and development mode warns about it. Auth attributes in a selection aren't persisted unless a declaration carries code.
- **Equality is over serialized declarations:** names, descriptions, schemas, and durable callback references with their captures. A re-run that returns the same tools doesn't re-announce anything or change the provider request.
- **Restores reuse slots.** A fresh process calls `run` with each stored selection only to rebuild code, and the recorded declarations win.
- **Redeploys re-resolve lazily.** Slots recorded under an older revision are stale, so each reaction runs again when it's next called. Nothing replays an event, and nothing goes on the stream.
- **Calls keep the declarations they started under.** A parked call's tools come from the slot recorded at its model call.

<details>
<summary>The runner, condensed from the prototype</summary>

```ts
async function afterCommit(commit: Commit, s: Session): Promise<void> {
  for (const r of s.reactions) {
    // Declarations eve reads later wait until their next read; everything else runs now.
    if (!s.callsAfter(r, commit)) continue;
    const selection = r.select?.(s.view, s.selectContext(r)) ?? null;
    const digest = hash(canonical(selection));
    const slot = s.slots.get(r.id);
    if (slot?.revision === r.revision && slot.digest === digest) continue; // reuse
    const entries = await guard(r, () => r.run(selection, s.runContext(r, commit)));
    const { declarations, requests } = split(entries); // KEEP keeps the slot's declarations
    // decided or checked; visible to later reactions in this pass, and saved with the next commit
    s.replaceSlot(r, {
      declarations,
      digest,
      selection: hasCode(declarations) ? selection : undefined,
    });
    s.request(requests); // the machine decides on them after this pass
  }
}
```

In the prototype, the runner and fact dispatch together are about 120 lines. That excludes what eve's declaration kinds add: validation, durable callbacks, and merging across slots. The prototype returns one value per reaction rather than a list of entries, and stores whole selections; lists and digests aren't modeled.

The scenario tests cover:

- reuse;
- `KEEP`;
- equal results;
- reading earlier slots;
- restores, including detecting a rebuild that differs;
- redeploys;
- watch edges;
- the loop rule;
- a capture cursor across compaction;
- capped continuations;
- the selection size cap.

Two simulations cover calling `run` after every change against waiting until use, and detecting facts by count against by position.

</details>

### Order, loops, and visibility

- **One fixed order after each commit:**
  - first hooks and channels, right after the write;
  - then memory, the model, connections, subagents, tools, skills, and instructions, as today.

  A reaction may select the slots of reactions earlier in the order, and never later ones. There's no dependency graph.

- **One ordering change, already made in the pipeline PR:** memory used to run between the write and the hooks, and now runs after them. The only visible effect: a hook that cancels the turn from `turn.started` now stops recall for a turn that won't call the model.
- **No loops:** a commit that only updates slots triggers no evaluation, and requests are issued only when `run` runs.
- **Visibility is per surface.** Effect-only reactions never see model messages, connection reactions get none either, and capture gets the messages it stores.

## Authoring

There are three layers, each built on the next:

1. **Static files,** for most agents.
2. **Sugar:** `defineDynamic`, memory providers, hooks, and channels. Each is `select` plus one verb.
3. **`defineReaction`,** which returns entries. It's for eve's built-ins first, and for extension authors once it has its own research doc and e2e tests.

### Dynamic capabilities

**`defineDynamic` wraps exactly what the file would export statically, and `resolve` returns that:**

- a `defineSkill` in `skills/x.ts`;
- a tool, or a map of tools, in `tools/x.ts`;
- a `defineAgent` in any `agent.ts`, root or subagent;
- an extension mount in `extensions/x.ts`.

Settings needed before any session exists sit beside `select` and `resolve`, the way `build` already does for dynamic subagents. `defineDynamic` has one implementation, and the entry point for each kind only types `ctx` and the result.

```ts
// agent/skills/team_playbook.ts: follows the current caller
export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.team ?? null,
  resolve: (team) => (team && PLAYBOOKS[team] ? defineSkill({ markdown: PLAYBOOKS[team] }) : null),
});

// agent/agent.ts: the same shape as a subagent's agent.ts
export default defineDynamic({
  select: (_view, ctx) => ({
    pro: ctx.session.auth.current?.attributes.plan === "pro",
    images: hasImages(ctx.messages),
  }),
  resolve: ({ pro, images }) =>
    defineAgent({ model: images ? visionModel : pro ? proModel : defaultModel }),
});

// agent/tools/orders.ts: expensive work, once per turn
export default defineDynamic({
  select: (view) => activeTurn(view)?.turnId ?? null,
  async resolve(_turnId, { abortSignal }) {
    const status = await fetchWarehouseStatus({ signal: abortSignal });
    return status.acceptingOrders ? { checkStock, placeOrder } : { checkStock };
  },
});
```

- **One shape everywhere.** The root agent, a subagent, a skill, and a tool all look the same, and a definition never contains a `defineDynamic`.
  - A field can't express absence anyway, such as a skill that's sometimes missing, so wrapping the whole definition is the only form that covers every case.
  - Returned with the model, `modelOptions` and `modelContextWindowTokens` belong to the model they're for. The dynamic model form forbids both today.
  - Build-time fields can't vary per session: `build`, `defaultTools`, `experimental`, and `tool` exposure. They sit beside `select` and `resolve`, or must be static ([Open questions](#open-questions)).
- **Names come from the file or the map key.** One definition is named by its file; a map names each entry by its key, as dynamic maps do today. Those names are the declarations' keys.
- **Select the fact, not the data.** `hasImages(ctx.messages)` changes once, while `ctx.messages.length` changes at every model call.
- **Data outside eve needs an explicit dependency,** such as the turn.
- **There's no timing to get wrong.** A skill is read at turn start because it's a skill ([Entries](#entries)), so a skill resolver that silently never runs can't be written.

### Memory

Memory splits by what each part declares, and `ctx.moment` goes away:

```ts
export default defineMemoryProvider({
  recall: {
    select: (_view, ctx) => ({ scope: ctx.memory.scope.key, query: latestUserText(ctx.messages) }),
    resolve: ({ scope, query }, { abortSignal }) =>
      store.search(scope, query, { signal: abortSignal }),
  },
  tools: {
    select: (_view, ctx) => ctx.memory.scope.key,
    resolve: (scope) => memoryTools(scope),
  },
  // Messages capture hasn't seen yet: at a completed turn, and before compaction removes them.
  capture: (messages, ctx) =>
    store.save(ctx.memory.scope.key, messages, { idempotencyKey: ctx.operationId }),
});
```

- **Recall declares context, which is read before each model call.** eve already keeps recalled records through compaction, so recall runs again only when its selection changes. A provider that wants a fresh recall after compaction selects the latest compaction's ID.
- **Capture keeps a cursor.** It declares data, how far it has captured, which it reads back as `ctx.previous`. Data is called right after the commit, so capture runs before a compaction removes anything. It sees each message once, and providers stop deduplicating. Today `capture` receives the whole history each time.
- **At turn start, `ctx.messages` includes the incoming delivery,** so one query works every time recall is evaluated. Today that delivery is only in `ctx.turn.input`.
- **Isolation by construction.** `resolve` sees only what it selected, so a recall that doesn't select the scope can't query with it.

### Hooks and channels

Fact handlers stay, and a watch form joins them:

```ts
// agent/hooks/notify-idle.ts
export default defineHook({
  select: (view) => idle(view),
  onChange(isIdle, ctx) {
    if (isIdle) notifyOwner(ctx.session.id); // ctx.previous holds the prior selection
  },
});
```

- **A watch declares nothing,** so it's called right after any commit that changes its selection. Its selection's digest is recorded. Effects are at-least-once, keyed by `ctx.position`.
- **`ctx.cancel()` becomes a cancel request,** the one request hooks can make today.
- **Event maps stay the typed way to receive facts.** They're sugar for a selection of each key's latest position ([Facts are selections too](#facts-are-selections-too)).
- **It fills the one gap the event model leaves.** "Nothing is running" is currently `idle(ctx.view)`, checked in whichever handler you guess ends the work. A watch says it directly, and built-in status lines become watches on `activity`.
- **Channels take the same two forms.** Their handler signature becomes `(fact, ctx)` with `ctx.channel`, so every callback is `(input, ctx)`. Channel event names already break in v27, so the codemod moves the argument at the same time.

<details>
<summary>Under the hood: every surface as sugar</summary>

```ts
// defineDynamic: definitions become declarations keyed by the file or the map key.
const defineDynamic = ({ select, resolve }) =>
  defineReaction({
    select,
    run: async (selected, ctx) => toEntries(await resolve(selected, ctx), { key: fileSlug }),
  });
// toEntries: one definition → [declare(fileSlug, definition)]; a map → one declaration per key,
// in order; null → [], which withdraws everything; undefined → KEEP.

// A memory provider is three reactions.
defineReaction({
  select: recall.select,
  run: async (selected, ctx) => [context(slot, await recall.resolve(selected, ctx))],
});
defineReaction({
  select: tools.select,
  run: async (selected, ctx) => toEntries(await tools.resolve(selected, ctx), { prefix: slot }),
});
defineReaction({
  select: (view) => [view.latest["turn.settled"], view.latest["context.started"]],
  run: async (_latest, ctx) => {
    const due = ctx.facts.some(
      (fact) => (fact.type === "turn.settled" && isCompleted(fact)) || isCompaction(fact),
    );
    if (!due) return KEEP;
    const fresh = ctx.messagesAfter(ctx.previous?.cursor);
    await capture(fresh, ctx);
    return [data("cursor", fresh.at(-1)?.seq ?? ctx.previous?.cursor)];
  },
});

// Hooks: an event map selects each key's latest position and dispatches ctx.facts.
// A handler's ctx.cancel() becomes [cancel()].
defineReaction({
  select: (view) => keys.map((key) => view.latest[key] ?? null),
  run: (_latest, ctx) => dispatch(events, ctx.facts),
});
defineReaction({
  select,
  run: async (selected, ctx) => {
    await onChange(selected, ctx); // a watch declares nothing
    return [];
  },
});

// Built-ins: the same primitive, so eve is built with eve.
defineReaction({
  select: (view, ctx) => ctx.requestTokens > compactionThreshold(view),
  run: (over) => (over ? [compact({ reason: "threshold" })] : []),
});
defineReaction({
  select: (view) => skillNames(view), // from the skill slots
  run: (names) => [context("skills", announceSkills(names))],
});
```

</details>

### Conditional bundles

One reaction can declare several kinds, so one condition that gates tools, a skill, and instructions is one function rather than three files with the same `select`:

```ts
// agent/dynamic/enterprise.ts: proposed; where mixed results live is open
export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.plan === "enterprise",
  resolve: (enterprise) =>
    enterprise
      ? {
          crm_search: defineTool({/* … */}),
          enterprise_playbook: defineSkill({ markdown: PLAYBOOK }),
          enterprise_tone: defineInstructions({ content: "…" }),
        }
      : null,
});
```

Each entry applies when its kind is read: the tool at the next model call, and the skill and instructions from the next turn.

Whole extensions follow the same rule. A mount file exports what the extension's default export returns, so a dynamic mount wraps that:

```ts
// agent/extensions/crm.ts
export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.plan === "enterprise",
  resolve: (enterprise) => (enterprise ? crm({ apiKey: process.env.CRM_API_KEY! }) : null),
});
```

- **Timing:** membership is read at turn start, and each piece inside then applies at its own moment.
- **Memory providers are already bundles** of recall, tools, and capture.
- **Scope:** a dynamic mount gates only session-scoped pieces. Channels, routes, and schedules stay global.

This is a direction, not part of the plan.

## What a generic reaction enables

| Behavior                                                                                                          | The reaction returns                                                  | Today                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Modes: one reaction decides "read-only" or "plan", and tools, approvals, instructions, and the model select on it | A data declaration that later reactions select                        | Each resolver recomputes its own condition                            |
| Context from state mid-turn: "80% of the budget is used", "deploy failed twice"                                   | A context declaration, read before each model call                    | Contributions only at turn start and after compaction                 |
| Context edits: drop stale tool outputs, collapse resolved errors, redact across tools                             | Context edits, a new declaration kind                                 | Only compaction rewrites history; result shaping is per tool          |
| One policy across every call: approval by session state, arguments from state, recorded mocks in evals            | A clearance, a new declaration kind, read after each `call.requested` | `approval` is set per tool; nothing settles a call without running it |
| Derived state, exactly once: counters, todo lists, cost per tool                                                  | Data declarations, called right after each commit                     | Hooks write `defineState` with at-least-once delivery                 |
| Follow-up turns and steering                                                                                      | Continue and steer requests                                           | Only `ctx.cancel()`                                                   |
| Timers per session: remind about an open approval, expire a grant                                                 | A wake-up request, a new request kind                                 | A once-a-minute schedule over an application store                    |
| Request shaping: reasoning effort, cache breakpoints, masking tools instead of removing them                      | Request parameters, a new declaration kind                            | Only the model is dynamic                                             |
| Explaining decisions: "tools changed at r6 because `deployed` went from false to true"                            | Nothing new: slots and their recorded selections already say it       | Not possible                                                          |

- **Cheap:** modes, mid-turn context, derived state, and explanations fall out of the runner and today's declaration kinds.
- **Needs a new entry kind, and code that reads it:**
  - requests other than cancel;
  - clearances, read after each `call.requested`;
  - context edits;
  - wake-up requests, which also need committed time in the view;
  - request parameters.

None of these is part of the plan below.

## Relationship to a session log

Reactions need **entry-shaped commits**: every private change is an entry produced in a commit and folded into the view. They don't need private entries kept as the source of truth. In the meantime, [`session-event-lifecycle.md`](./session-event-lifecycle.md#toward-a-session-log) already asks for exactly that: "new private state should be entry-shaped… even while it's stored in checkpoints."

- **Reactions shrink the log's hard problems.** About 30 of the context keys a log would migrate become reaction entries. Reactions also don't need model history derived from entries, which is the hardest part.
- **Public views can already grow.** The public stream is a log, and server readers fold it from line 0.

Where a checkpoint-only approach runs out, the fixes are narrower than a full log:

<details>
<summary>Four limits, and the narrowest fix for each</summary>

| Limit                                                                                                                               | Fix                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A step dies after its public line but before its checkpoint, so a retry could decide differently from what `model.started` recorded | Either accept at most one re-decision per retry, as effect-only reactions already do, or write reaction entries to a private side stream before the public line. That's the "split" layout child bindings already use |
| A fold added later only sees commits from then on                                                                                   | Accept forward-only before 1.0, and record cheap inputs as entries before any fold reads them                                                                                                                         |
| Rewind, fork, and undoable context edits need raw model history                                                                     | Log only the model-context fold, once rewinds are a product goal                                                                                                                                                      |
| Explaining and replaying decisions needs their history                                                                              | Keep slot entries, which are small                                                                                                                                                                                    |

Five rules keep a log possible later:

- Folds stay pure and versioned.
- Nothing writes context outside a fold.
- Reactions read only the view and `ctx`.
- Outputs carry their position and reference public IDs.
- Reactions emit requests, never facts.

</details>

## Performance

### The runner's own cost

These numbers come from the prototype on an 8-core Xeon (2.9 GHz) with Node 24. They exclude user code, so a resolver's own I/O comes on top.

| Case                                                    | Cost                                        |
| ------------------------------------------------------- | ------------------------------------------- |
| 20 reactions evaluated together, none changed           | 7 µs per evaluation                         |
| One reaction re-run whose 5 tools come back equal       | 48 µs                                       |
| 10 watches after a commit                               | 15 µs                                       |
| A 50-call turn with 20 reactions, end to end in the toy | 28 µs per model call (510 selects, 20 runs) |

- **The common path is negligible.** Before every model call, the runner costs microseconds, against seconds of model latency.
- **The equal-result case** is dominated by serializing the new declarations once. The recorded side's digest is stored with the slot.

### Compared with today

- **Per-delta dispatch goes away.** Today every published event, each delta included, waits on eight dispatchers in turn. Declarations eve reads later are evaluated only after the commits that announce their use, and everything else only after commits that have facts.
- **Connection replays go away.** Today connection resolvers re-run before every model call. They become slots that re-run only when their selection changes.
- **Per-call resolvers get cheaper.** A `step.started` resolver runs in full before every model call. As a reaction, a cheap `select` runs instead, and `resolve` only on a change.
- **Session-level tool and model resolvers gain one small cost:** a `select` per model call, which disappears when there's nothing to select.

### Costs to manage

- **Selections that scan history.** A `select` that walks every message before every call is quadratic over a long turn.
  - In the prototype, with tiny messages, it took about 0.7 ms in total over 1,000 calls and 16 ms over 5,000. An aggregate kept in the view took about 0.01 ms.
  - Real messages are larger.
  - Mitigations: aggregates in the view for common facts (attachments, usage, successful calls by tool), a time budget per `select` in development, and the cap on stored selections.
- **Tool changes mid-turn and the prompt cache.**
  - For Anthropic models, eve places a cache breakpoint at the end of the tools block (`harness/prompt-cache.ts`), so a changed tool set misses everything cached up to that point. Anthropic invalidates its whole cache when tool definitions change.
  - Early cutoff keeps equal re-runs from changing the request.
  - Separating how a decision is presented from the decision itself would keep rare changes cheap: remove tools only at turn start, and mask or append mid-turn where a provider supports it ([Open questions](#open-questions)).
- **Churn.** A selection that changes at most evaluations re-runs `resolve` each time. Development mode warns about a reaction that re-runs at most of its evaluations.
- **Redeploys.**
  - After a deploy, every active session re-runs every reaction at its next evaluation.
  - The work is spread over sessions' next turns rather than concentrated at deploy time, and equal results change nothing. The external calls still happen.
  - A code fingerprint per reaction, instead of the deployment ID, would re-run only what changed.
- **Restores.**
  - A fresh process calls `run` for each slot whose declarations carry code. Today the equivalent is rebinding tool callbacks and re-running connections.
  - Rebuilding lazily, when a call first needs the code, keeps cold steps cheap.
- **Storage.**
  - One current slot per reaction, plus older ones while calls that started under them are open.
  - Only selections for declarations with code are stored whole, under a cap (4 KiB in the prototype). Everything else stores a digest. Declarations are what today's durable tool metadata already stores.
  - Entries ride the checkpoint and never reach the stream.

### Not measured

- Workflow step overhead.
- Checkpoint serialization.
- Real resolver I/O.
- The cost of keeping views immutable in eve's fold. The prototype clones the view per commit, and its end-to-end number includes that.

## Compatibility

Every dynamic resolver and memory provider changes shape. The change aims to ship in the same release as the event break ([`session-event-lifecycle.md`](./session-event-lifecycle.md#compatibility-at-the-break)), so authors migrate once. It's the last PR of the break, so if it isn't ready, the break ships without it and the API follows in a later release.

- **A codemod keeps today's timing.** Each key maps to the selection that resolves exactly as often:
  - `session.started` to no `select`;
  - `turn.started` to the turn's ID;
  - `step.started` to the requested run's ID.
- **What the codemod can and can't do:**
  - Handlers that read nothing from `ctx` convert mechanically.
  - Of the roughly 210 files that use `defineDynamic`, about half read `ctx` in a handler. This comes from a rough grep, not a parse.
  - The codemod moves simple reads into the selection. For example, `ctx.session.auth.current` in a `session.started` handler becomes a selection of `auth.initiator`, which is the same caller at session start.
  - It leaves a TODO where it can't, chiefly in the dozen or so files that read `ctx.messages`, which need to select a fact instead.
  - Authors can then narrow selections by hand, for example a turn resolver that depends only on the caller. The codemod can't know what data outside eve a resolver depends on.
- **Memory providers.**
  - `recall` maps become `{ select, resolve }`. The codemod selects the turn's ID, which preserves today's recall every turn.
  - `compaction.completed` recall goes away, because recalled records are kept through compaction.
  - `capture` receives only messages it hasn't seen. A provider that relied on the full history needs a change. One that deduplicated can drop the deduplication.
  - `tools` become `{ select, resolve }`.
- **Hooks and channels.**
  - Hook event keys change with v27's own break, and watches are additive.
  - If the channel signature change is adopted, `(event, channel, ctx)` becomes `(fact, ctx)`, moved by the same codemod as v27's renames.
- **Dynamic fields become dynamic files.** `defineAgent({ model: defineDynamic(...) })` becomes an `agent.ts` that exports `defineDynamic` returning `defineAgent({ model })`, the shape dynamic subagents already have. The codemod rewrites it, keeping the agent's other fields static beside `select` and `resolve`.
- **The old shape fails the build with the fix.** A `defineDynamic` with `events`, or a memory provider with maps, gets an error that points at the codemod. It's an error, not an alias, and it can be removed after a release or two.
- **The untyped payload goes away.** Reactions receive the typed view instead of an `unknown` event.
- **Running sessions don't cross the break,** so recorded slots can change shape there.
  - The pipeline PR on `main` keeps today's durable keys.
  - If the API ships in a later release, sessions do cross it. Results recorded under today's keys then count as stale, so each reaction runs again at its next evaluation, as after a redeploy.
- **Extension contracts.** Retained epochs whose fixtures author `defineDynamic({ events })` are dropped with a reason: 57 for dynamic tools, 29 for instructions, 28 for skills, 9 for subagents, and 5 for connections. Each capability gets a new epoch.
- **Third-party extensions and memory providers** built against the old API break until they update.
- **In this repo,** the migration covers:
  - 51 e2e fixture files and 19 framework source files that use `defineDynamic`;
  - the file memory provider and two e2e memory fixtures;
  - 7 docs pages, two template files, `eve-code`, and one app fixture.

## Plan

There are three steps in the overall plan ([`session-event-lifecycle.md`](./session-event-lifecycle.md#phases)). What's certain lands first. The API is the least certain part, so it's the last PR of the break and can come last.

1. **On `main`, now: the pipeline behind today's API.**
   - One pipeline runs every participant in the fixed order, after the hooks, and builds the events today's handlers expect in one place.
   - A table of the keys each kind accepts replaces the `ALLOWED_DYNAMIC_*` sets, and an unsupported key fails the build.
   - It's shaped as the runner's skeleton: participants are evaluated after the commits that announce their use, in the fixed order. Step 3 then changes what's evaluated, not when.
   - Tests pin when today's participants run. They assert on handler calls and model input rather than event shapes, so they survive the wire change:
     - memory recall before the first model call;
     - dynamic model selection per model call, and for a manual compaction;
     - skills and instructions only at turn start;
     - the refresh after a redeploy;
     - restoring a parked step's tools.

   It changes nothing for authors. It touches `execution/session/turn-step.ts`, `harness/model-call/run.ts`, and `harness/hitl/intake.ts`. HumanInput (#4342–#4344) also changes those files, so whichever lands second rebases rather than waiting.

2. **In the conversation slice: today's API on v27 commits.** The pipeline runs after the v27 commits that announce each use, from one table, instead of on v26 event types. Today's keys become names for those commits:

   | Key                    | Runs after                                                 |
   | ---------------------- | ---------------------------------------------------------- |
   | `session.started`      | The first commit with `turn.started`                       |
   | `turn.started`         | Each commit with `turn.started`                            |
   | `step.started`         | Each commit with `model.requested`                         |
   | `turn.completed`       | A commit with `turn.settled`, outcome `completed`          |
   | `compaction.requested` | A commit with `context.started` for a compaction           |
   | `compaction.completed` | A commit with `context.settled` for a completed compaction |

   A handler's first argument is typed `unknown`. The only readers in the repo take the turn's ID (`models/auto.ts`) and its sequence (an e2e instruction fixture). So a minimal private payload with those fields stands in for the event, with its own types once the v26 builders are gone. Durable keys stay as they are.

3. **At the top of the integration branch: the API.**
   - What it adds:
     - `select` and `resolve`;
     - the memory reshape;
     - entries, with reaction slots in place of today's session, turn, and step metadata;
     - `defineDynamic` wrapping whole definitions, including a dynamic `agent.ts`;
     - restores from recorded selections;
     - the development checks;
     - typed entry points and the selectors reactions need;
     - the build errors, the codemod, the repo migration, the docs, and the tests.
   - What it deletes: the private payload, the redeploy refresh, and the callback rebind paths.
   - It aims to ship in the same release as the break. If it isn't ready, the break merges without it ([Compatibility](#compatibility)).

**Size:** a small net reduction, not measured.

- **Removed by the three steps:** a few hundred lines of dispatch and synthetic-event code, across `turn-event-handler.ts` (140), `resolver-events.ts` (29), `memory-event-lifecycle.ts` (76), and the filtering parts of the six `context/dynamic-*-lifecycle.ts` files. The pipeline, selection comparison, and recording add back something smaller.
- **Also replaced by step 3:** the per-kind recording in `context/dynamic-*.ts`, about 1,600 lines, becomes one slot per reaction. How much of it goes depends on how much of the durable callback and schema replay machinery survives, which isn't estimated here.

**Beyond the plan, not scheduled:**

- **Watches and the channel signature.** These would change the observer section of `session-event-lifecycle.md`: the "nothing is running" guidance, and the channel handler's arguments. If they're accepted, they belong in the conversation slice, next to the hook and channel maps.
- **`call.request`,** next to the executor's approvals decided by eve.
- **Requests beyond cancel, timers, context edits, request parameters, and conditional bundles,** as minors after the break, each with its own doc.
- **A public `defineReaction`,** once eve's own sugar has proven it.

## Open questions

**Semantics:**

1. **Revisions per reaction.** A redeploy re-runs every reaction in every session that takes it over, so every external source gets called after a deploy. A fingerprint per reaction module, instead of the deployment ID, would re-run only reactions whose code changed. Can the bundle provide a stable one?
2. **Presenting a decision versus making it.** Tools can change at any model call. [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) invalidates the whole cache when tool definitions change, and [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) recommends stable tools with `allowed_tools`. Should the harness keep the decision separate from the request, removing tools only at turn start and masking or appending mid-turn where a provider supports it?
3. **History beyond the operational view.** `ctx.view` prunes closed calls and turns, so a selection can't count earlier deploys or failures. Should reactions be able to declare folded aggregates that survive pruning, as `extendConversation` does for clients? Or should they derive such facts from `ctx.messages`?
4. **Periodic refresh.** Selecting the turn refreshes every turn. "At most every ten minutes" needs a committed time in the view, such as the `at` of the turn's start commit, and rows don't carry one today. Timers need the same.
5. **Restores that rebuild something different.** A restore calls `resolve` with the recorded selection, but an outside source may have changed since; the prototype detects the mismatch. When the rebuilt result lacks a recorded tool, or its schema differs, does the call fail, or does the recorded declaration win?
6. **The cap on stored selections.** Only selections stored to rebuild code are capped. Should the cap be small, as the prototype's 4 KiB, or generous, such as 64 KiB, since it bounds stored data per reaction rather than traffic per commit?
7. **Revision changes mid-turn in development.** Locally, the revision is the compiled artifacts' key. It changes on a rebuild, possibly while a turn is paused; today the refresh runs at any step start. Under this proposal:
   - the model and tools re-resolve at the next model call;
   - everything else re-resolves at the next turn;
   - code is rebuilt from recorded selections in between.

   Is that intended, and does "only while idle" need a local exception?

**Authoring:**

8. **Resolvers with several keys.** Seven in this repo, including `self-modification/agent.ts`, handle two keys whose results layer today: a turn result overrides a session result of the same name. With one slot per reaction, the codemod can either merge them under the turn's selection, which redoes the session work every turn, or leave a TODO. Which?
9. **Session state read around the selection.** `resolve` runs inside the session's async context, so `defineState(...).get()` still reads session state it didn't select, and one fixture (`dynamic-overwrite.ts`) writes state from a resolver. Should `resolve` run outside the session's context, or is "`resolve` reads only its selection" a documented convention? Writes also repeat when a restore calls `resolve` again.
10. **Recall after compaction.** Memoized recall no longer runs again automatically after a mid-turn compaction, although the recalled records stay in context. Is that acceptable as the default?
11. **Where mixed results live.** A slot folder stays predictable if it returns only its own kind. Should a result that mixes kinds go in one `dynamic/` folder, or be allowed in any folder?
12. **Build-time fields in a dynamic `agent.ts`.** `build`, `defaultTools`, `experimental`, and `tool` exposure can't vary per session. Should they sit beside `select` and `resolve`, as `build` does for dynamic subagents, or must they be static, with the compiler checking that each result agrees?
13. **Verbs.** The base layer's `run` returns entries; the sugar uses `resolve` where it returns definitions and `onChange` where it declares nothing. Should there be one verb everywhere instead? It shouldn't be `react`, since `eve/react` exists.

**Scope:**

14. **Watches and the channel signature.** Should they land in v27, or as a minor after it? They're additive for hooks and breaking for channels.
15. **Requests.** Which come first after cancel, with what caps per delivery, and is `cause: {reaction}` enough attribution?
16. **A public `defineReaction`.** When does it become public? Are the entry kinds, and the moments eve reads them, part of that contract, or kept to eve's sugar?
