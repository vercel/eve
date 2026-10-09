---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-09"
---

# Session reactions

Read on `main` at `8c55ea7c1`, and modeled in a standalone prototype of about 700 lines with 12 scenario tests, microbenchmarks, and three simulations. Nothing in eve was changed. This doc replaces `dynamic-participants.md` and keeps its plan.

## Summary

Four authoring surfaces react to a session (dynamic resolvers, memory providers, hooks, and channels), and so do about a dozen built-ins. Each has its own dispatch, timing, recording, and replay:

- **Participants run on events that never happened.** The state machine hand-builds `session.started`, `turn.started`, and `step.started` to drive resolvers before model calls, on restores, and after redeploys.
- **Keys fix when, not what.** A `session.started` resolver that reads the caller keeps the first caller's answer for the whole session.
- **The same machinery exists many times,** in about 3,300 lines of per-kind lifecycles, loaders, normalizers, and memory code.
- **It costs work.** Every event a turn publishes, deltas included, waits on eight dispatchers in turn, and connection resolvers re-run before every model call.

This doc proposes one primitive underneath all of them, a **reaction**:

```text
select(view, ctx)        what it depends on: synchronous, deterministic JSON
resolve(selected, ctx)   what it is now: entries, or nothing; may do I/O
```

`resolve` is called after its selection changes, and before anything it returned is next read. Nothing else triggers it.

- **A reaction's latest output is its current state,** recorded as its slot. Entries are tools, skills, a model, context, data, or **intents** such as "a compaction is wanted", which the machine acts on once.
- **Selections notice facts too,** so authors never declare when a reaction runs or which events it subscribes to.
- **`defineHook` is the public reaction.** `defineDynamic`, memory providers, channels, and eve's built-ins are sugar over the same primitive, with one verb: `resolve`.
- **It enables behaviors that have no home today,** such as modes, context added mid-turn, one policy across every call, and follow-up turns ([What a generic reaction enables](#what-a-generic-reaction-enables)).
- **It's cheap.** In the prototype, 20 unchanged reactions cost about 7 µs per model call ([Performance](#performance)).

The plan is unchanged. The pipeline lands on `main` behind today's API, the conversation slice moves it onto v27 commits, and the API is the last PR of the break.

## The model in one picture

```text
inputs ──▶ machine ──facts─────────────┐
              ▲                        ▼
              │                      commit ──fold──▶ view ──▶ reactions: select → resolve
              │                        ▲                                   │
              │                        └───── reaction.changed (new slot) ◀┘
              └─────────── reads the view, slots and intents included
```

It's events flowing through one state machine. There are three kinds, each with one writer:

- **Inputs,** such as deliveries, arrive from outside.
- **Facts** come from the machine, which is pure: it does no I/O, and nothing else writes facts.
- **`reaction.changed`** comes from reactions, which may do I/O but write only their own slot.

Folds are the only way anything becomes state, and capability assembly, context assembly, and the machine all read the view. A slot change is the session-log sketch's `capabilities.changed` entry, kept in the checkpoint until there's a log.

What a reaction returns decides when eve calls it and what a failure means. That's all that remains of the split between "participants" and "observers":

|              | Returns something eve reads later: tools, a model, skills, context | Returns data, intents, or nothing                 |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------- |
| Called       | Before it's next read                                              | Right after the commit that changed its selection |
| On restore   | The slot is reused                                                 | The slot is reused; effects repeat at most once   |
| If it throws | The kind's rule: fail the turn, omit, or contribute nothing        | Logged, and its intents are withdrawn             |

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

### `select` and `resolve`

```ts
interface Reaction<S extends Json> {
  select?(view: SessionView, ctx: SelectContext): S;
  resolve(selected: S, ctx: ResolveContext): Entry[] | typeof KEEP | Promise<Entry[] | typeof KEEP>;
}
```

That's the whole primitive, and `defineHook` is its public form ([Hooks are the public reaction](#hooks-are-the-public-reaction)).

- **`select` declares the inputs.** It's synchronous and deterministic, and returns JSON. Omitting it means `resolve` runs once. Development mode evaluates it twice to catch clock reads, and a `select` that throws is treated like `resolve` throwing.
- **`resolve` gets the selection, not the view,** so it can't depend on state it didn't select. Its context adds services such as `abortSignal`, its own previous slot as `ctx.previous` (for cursors and counters), and the facts since its last call as `ctx.facts`.
- **Returning nothing keeps the slot,** and `null` clears it. Internally, that's `KEEP`.
- **IDs come from file paths,** like every other eve name.

### When `resolve` is called

Authors never choose the moment. eve does, from when each kind of entry is read ([Entries](#entries)):

- **Entries eve reads later can wait until they're needed:** tools and a model until the next model call, and skills, instructions, connections, and subagents until the next turn. Waiting can't change the answer, because `resolve` sees only the selection; it only saves work. In a prototype simulation where a selection flips between uses, waiting gave the same answers in 2 runs instead of 6.
- **Everything else is called right after the commit that changed its selection.** Data can be read at any time, intents are for the machine's next decision, and an effect's timing is the behavior.
- **Either way, it's after a commit.** v27 commits a fact at each moment eve needs an answer, which is why `model.requested` exists, and a commit's reactions finish before the next commit.
- **Summary runs** follow today's plan: the dynamic model is evaluated at the summary run's `model.requested` unless `compactionModel` is set, and tool reactions never see summary runs.

### Facts are selections too

The view keeps the position of the latest fact of each type, so a new fact is an ordinary change in a selection:

```ts
// agent/hooks/audit.ts
export default defineHook({
  select: (view) => view.latest["call.settled"] ?? null,
  resolve: (_position, ctx) => {
    for (const fact of ctx.facts) if (fact.type === "call.settled") audit.write(fact);
  },
});
```

- **Select an identity, not a count.** Two commits that each settle one call have the same count. In a prototype simulation, counting missed one of five settles, and selecting the latest position caught all of them.
- **Hook `events` maps and channel handlers are typed sugar for this.** Filters such as "completed turns only" check in `resolve`, and eve can index the sugar by fact type.
- **Entries eve reads later shouldn't depend on `ctx.facts`,** because eve may wait to call them. They select an aggregate instead, such as `view.succeeded.deploy`.
- **Restores don't fire again,** because the positions are in the view.

### Entries

`resolve` returns a list of entries, and **the latest list is the reaction's current state.** It replaces the slot, so anything missing is withdrawn. Each kind is read by eve's code for that kind:

| Entry                                            | Read by, and when                                                                       | If `resolve` throws                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| A model                                          | The next model call                                                                     | Fails the turn                                      |
| Tools (`defineTool` values)                      | Every model call: validated, named, and merged across slots                             | Omitted and logged                                  |
| Skills, subagents                                | Captured at turn start, for the turn                                                    | Omitted and logged                                  |
| Instructions                                     | System role: replaced per slot. User role: appended when a new selection resolves to it | Contributes nothing, and never keeps an older value |
| Connections                                      | Captured at turn start, for the turn                                                    | Parks the session, as today                         |
| Context (recall, announcements, notes, steering) | Every model call                                                                        | The surface's rule; recall fails the turn           |
| Data                                             | Other reactions and selectors, through the slot                                         | Logged                                              |
| Intents                                          | The machine, right after the commit ([Intents](#intents))                               | Withdrawn, so never acted on                        |

- **Keys are names, scoped by kind.** `defineDynamic` takes them from the file path or a map key. Two reactions declaring the same name is an error, as today.
- **One reaction can return several kinds,** and each applies when its kind is read.
- **Later reactions read earlier slots through `select`.** That's how tools follow a mode, or a subagent follows the model.
- **There are no deltas.** The whole list replaces the slot, the way React's render returns the full tree, and it's the sketch's `capabilities.changed` entry ([`session-event-lifecycle.md`](./session-event-lifecycle.md#toward-a-session-log)).
- **Per-kind logic stays only where it's essential:** tool naming and durable callbacks, skill sandbox sync, connection sign-in, and the fact that satisfies each intent.

### Intents

An intent is an entry the machine reads: a standing wish, such as "a compaction is wanted". The machine acts on it once because it checks its own facts, the way a Kubernetes controller compares desired state with what has happened. **An intent counts from the slot change that added it, and is satisfied by the first matching fact after that:**

| Intent              | Key                                | Satisfied by                                             |
| ------------------- | ---------------------------------- | -------------------------------------------------------- |
| Compact             | The trigger, such as `"threshold"` | The next `context.started` for a compaction              |
| Continue            | The turn it follows                | A `turn.started` caused by this reaction after that turn |
| Cancel              | The turn                           | That turn's `turn.settled`                               |
| Open an interaction | The interaction's key              | `interaction.opened` with that key                       |
| Start a task        | The task's key                     | `task.started` with that key                             |

Steering isn't an intent: a note for the next model call is just context.

- **Only the machine writes facts,** and it can refuse, for example after the session has closed.
- **No loops, and no queue.** A slot changes only when its selection does, and a satisfied intent stays satisfied, so retries and restores can't repeat it. Removing an intent before the machine acts cancels it. Continuations and started work also have caps per delivery.
- **Authority is explicit:** a turn a reaction starts carries `cause: {reaction}` and the agent's own principal, never the caller's.

<details>
<summary>The intent simulation</summary>

A prototype simulation (`intents.ts`) models a compaction trigger that selects `tokens > threshold` and resolves to a compact intent or nothing:

| Scenario                                                                       | Compactions              |
| ------------------------------------------------------------------------------ | ------------------------ |
| Context grows past the threshold 6 times, and each compaction reduces enough   | 6                        |
| Compaction only gets down to 110, so 20 commits stay above the threshold       | 1                        |
| Context drops back below the threshold before the machine acts                 | 0, and the slot is empty |
| A restore between the slot change and the machine's action, then another after | 1 in total               |

</details>

### Recording

Each time, eve evaluates `select`, and reuses the slot if the selection's digest and the code revision match. Otherwise it calls `resolve` and replaces the slot. Equality is over serialized entries, so a re-run that returns the same tools changes nothing, and only a changed slot commits a `reaction.changed`.

- **What's stored is small:** the slot and a digest of the selection. Entries with code, such as tools and connections with token callbacks, also store the full selection, which a restore passes back to `resolve` to rebuild the code. Only those selections are capped, and auth attributes in any other selection are never persisted.
- **Restores reuse slots,** calling `resolve` only to rebuild code.
- **Redeploys re-resolve lazily.** Slots from an older revision are stale, so each reaction runs again when it's next called. Nothing replays an event.
- **Calls keep the entries they started under.** A parked call's tools come from the slot recorded at its model call.

<details>
<summary>The runner, condensed from the prototype</summary>

```ts
async function afterCommit(commit: Commit, s: Session): Promise<void> {
  for (const r of s.reactions) {
    // Entries eve reads later wait until their next read; everything else runs now.
    if (!s.callsAfter(r, commit)) continue;
    const selection = r.select?.(s.view, s.selectContext(r)) ?? null;
    const digest = hash(canonical(selection));
    const slot = s.slots.get(r.id);
    if (slot?.revision === r.revision && slot.digest === digest) continue; // reuse
    const entries = await guard(r, () => r.resolve(selection, s.resolveContext(r, commit)));
    // KEEP or an equal list is `checked`; otherwise `decided`, which commits reaction.changed.
    // Either way, later reactions in this pass see the slot.
    s.replaceSlot(r, { entries, digest, selection: hasCode(entries) ? selection : undefined });
  }
  s.machine.reconcile(s.view); // acts on intents that aren't satisfied yet
}
```

In the prototype, the runner and fact dispatch together are about 120 lines, before eve's validation, durable callbacks, and merging. The prototype returns one value per reaction rather than a list, queues commands rather than reconciling intents, and stores whole selections; `intents.ts` models intents on their own.

The scenario tests cover reuse, `KEEP`, equal results, reading earlier slots, restores (including a rebuild that differs), redeploys, hooks firing on a change, the loop rule, a capture cursor across compaction, capped continuations, and the selection cap.

</details>

### Order, loops, and visibility

- **One fixed order after each commit:** hooks and channels first, then memory, the model, connections, subagents, tools, skills, and instructions. A reaction may select earlier slots and never later ones, so there's no dependency graph, and a mode a hook declares is visible to every capability.
- **No loops:** a commit that only updates slots triggers no evaluation.
- **Visibility is per surface.** Hooks and channels never see model messages, connection reactions get none either, and memory capture gets the messages it stores.

## Authoring

There are three layers, each sugar over the next:

1. **Static files,** for most agents.
2. **`defineDynamic`:** one definition computed from the session, in that definition's own folder. Memory providers and channels are bundles.
3. **`defineHook`:** the reaction itself, returning effects, data, intents, declarations, or a mix.

Every one of them is `select` plus `resolve`.

### Dynamic capabilities

**`defineDynamic` wraps exactly what the file would export statically:** a skill in `skills/`, tools in `tools/`, a `defineAgent` in any `agent.ts`, or an extension in `extensions/`. Settings needed before any session exists, such as `build`, sit beside `select` and `resolve`, as they already do for dynamic subagents.

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

- **One shape everywhere.** The root agent looks like a subagent, and no definition contains a `defineDynamic`. A field couldn't express absence anyway, and returning the whole agent lets `modelOptions` travel with the model it's for.
- **Names come from the file or the map key,** as they do today.
- **Select the fact, not the data.** `hasImages(ctx.messages)` changes once, while `ctx.messages.length` changes at every model call. Data outside eve needs an explicit dependency, such as the turn.
- **There's no timing to get wrong.** A skill is read at turn start because it's a skill.

### Memory

Memory splits by what each part returns, and `ctx.moment` goes away:

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

- **Recall is context,** read before each model call, and it runs again only when its selection changes. Recalled records already survive compaction.
- **Capture keeps a cursor in its slot,** so it sees each message once: right after the commit, before compaction removes anything. Providers stop deduplicating.
- **At turn start, `ctx.messages` includes the incoming delivery,** so one query works every time. Today the delivery is only in `ctx.turn.input`.
- **Isolation by construction:** a recall that doesn't select the scope can't query with it.

### Hooks are the public reaction

A hook is `select` plus `resolve`, like everything else:

```ts
// agent/hooks/notify-idle.ts: an effect when the selection changes
export default defineHook({
  select: (view) => idle(view),
  resolve: (isIdle, ctx) => {
    if (isIdle) notifyOwner(ctx.session.id);
  },
});

// agent/hooks/require-credentials.ts: a gate returns an intent instead of calling ctx.cancel()
export default defineHook({
  select: (view) => activeTurn(view)?.turnId ?? null,
  resolve: (turnId, ctx) =>
    turnId && !hasCredentials(ctx) ? cancel(turnId, "Sign in first") : null,
});
```

- **What `resolve` returns is the hook's slot.** An effect-only hook returns nothing, and is called right after any commit that changes its selection. Effects are at-least-once, keyed by `ctx.position`.
- **Returning `cancel(…)` is the one way to stop a turn,** and `ctx.cancel()` goes away.
- **Event maps stay,** as typed sugar whose handlers return the same things.
- **Mixed results live in hooks** ([Conditional bundles](#conditional-bundles)), and slot folders return only their own kind.
- **"Nothing is running" becomes a hook selecting `idle`,** instead of a check in whichever handler you guess ends the work. Built-in status lines become hooks selecting `activity`.
- **Hooks never see model messages,** even when they declare capabilities.
- **Channels take the same forms,** and their handlers become `(fact, ctx)` with `ctx.channel`, moved by the v27 codemod.
- **It's a public API,** so hooks returning more than effects and `cancel(…)` need their own doc and e2e tests ([Plan](#plan)).

<details>
<summary>Under the hood: every surface as sugar</summary>

`reaction()` is the internal form. `defineHook` is `reaction()` with the hook context, and every other surface is `reaction()` with its own context, which is how visibility stays per surface.

```ts
// defineDynamic: definitions become entries keyed by the file or the map key.
const defineDynamic = ({ select, resolve }) =>
  reaction({
    select,
    resolve: async (selected, ctx) => toEntries(await resolve(selected, ctx), { key: fileSlug }),
  });
// toEntries: one definition → [declare(fileSlug, definition)]; a map → one entry per key,
// in order; null → [], which withdraws everything; undefined → KEEP.

// A memory provider is three reactions, with a context that includes messages.
reaction({
  select: recall.select,
  resolve: async (selected, ctx) => [context(slot, await recall.resolve(selected, ctx))],
});
reaction({
  select: tools.select,
  resolve: async (selected, ctx) => toEntries(await tools.resolve(selected, ctx), { prefix: slot }),
});
reaction({
  select: (view) => [view.latest["turn.settled"], view.latest["context.started"]],
  resolve: async (_latest, ctx) => {
    const due = ctx.facts.some(
      (fact) => (fact.type === "turn.settled" && isCompleted(fact)) || isCompaction(fact),
    );
    if (!due) return KEEP;
    const fresh = ctx.messagesAfter(ctx.previous?.cursor);
    await capture(fresh, ctx);
    return [data("cursor", fresh.at(-1)?.seq ?? ctx.previous?.cursor)];
  },
});

// Event maps: select each key's latest position, and dispatch ctx.facts to the handlers.
reaction({
  select: (view) => keys.map((key) => view.latest[key] ?? null),
  resolve: (_latest, ctx) => dispatch(events, ctx.facts), // the handlers' entries, in order
});

// Built-ins: the same primitive, so eve is built with eve.
reaction({
  select: (view, ctx) => ctx.requestTokens > compactionThreshold(view),
  resolve: (over) => (over ? [compact("threshold")] : []),
});
reaction({
  select: (view) => skillNames(view), // from the skill slots
  resolve: (names) => [context("skills", announceSkills(names))],
});
```

</details>

### Conditional bundles

One hook can gate several kinds behind one condition, instead of three files with the same `select`:

```ts
// agent/hooks/enterprise.ts
export default defineHook({
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

Each entry applies when its kind is read: the tool at the next model call, and the skill and instructions from the next turn. A whole extension follows the `defineDynamic` rule, since a mount file exports what the extension returns:

```ts
// agent/extensions/crm.ts
export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.plan === "enterprise",
  resolve: (enterprise) => (enterprise ? crm({ apiKey: process.env.CRM_API_KEY! }) : null),
});
```

A dynamic mount is read at turn start and gates only session-scoped pieces; channels, routes, and schedules stay global. This is a direction, not part of the plan.

## What a generic reaction enables

Each row is a hook returning something new:

| Behavior                                                                                      | The hook returns                                                | Today                                                                 |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Modes: one hook decides "read-only" or "plan", and tools, approvals, and the model follow it  | Data that later reactions select                                | Each resolver recomputes its own condition                            |
| Context from state mid-turn: "80% of the budget is used", "deploy failed twice"               | Context, read before each model call                            | Contributions only at turn start and after compaction                 |
| Context edits: drop stale tool outputs, collapse resolved errors, redact across tools         | Context edits, a new entry kind                                 | Only compaction rewrites history; result shaping is per tool          |
| One policy across every call: approval by session state, arguments from state, mocks in evals | A clearance, a new entry kind, read after each `call.requested` | `approval` is set per tool; nothing settles a call without running it |
| Derived state, exactly once: counters, todo lists, cost per tool                              | Data, called right after each commit                            | Hooks write `defineState` with at-least-once delivery                 |
| Follow-up turns and steering                                                                  | A continue intent; a steering note is context                   | Only `ctx.cancel()`                                                   |
| Timers per session: remind about an open approval, expire a grant                             | A wake-up intent, a new intent kind                             | A once-a-minute schedule over an application store                    |
| Request shaping: reasoning effort, cache breakpoints, masking tools instead of removing them  | Request parameters, a new entry kind                            | Only the model is dynamic                                             |
| Explaining decisions: "tools changed at r6 because `deployed` went from false to true"        | Nothing new: slots and their recorded selections already say it | Not possible                                                          |

Modes, mid-turn context, derived state, and explanations fall out of today's entry kinds. The rest needs a new entry kind and the code that reads it; wake-up intents also need committed time in the view. None of it is part of the plan.

## Relationship to a session log

Reactions need **entry-shaped commits**: every private change is an entry produced in a commit and folded into the view. They don't need private entries kept as the source of truth. [`session-event-lifecycle.md`](./session-event-lifecycle.md#toward-a-session-log) already asks for exactly that in the meantime: "new private state should be entry-shaped… even while it's stored in checkpoints."

Reactions also shrink a log's hard problems. About 30 of the context keys a log would migrate become reaction entries, and reactions don't need model history derived from entries, which is the hardest part. Where a checkpoint-only approach runs out, the fixes are narrower than a full log:

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
- Reactions declare intents, never facts.

</details>

## Performance

### The runner's own cost

These numbers come from the prototype on an 8-core Xeon (2.9 GHz) with Node 24. They exclude user code, so a resolver's own I/O comes on top.

| Case                                                    | Cost                                        |
| ------------------------------------------------------- | ------------------------------------------- |
| 20 reactions evaluated together, none changed           | 7 µs per evaluation                         |
| One reaction re-run whose 5 tools come back equal       | 48 µs                                       |
| 10 hooks after a commit                                 | 15 µs                                       |
| A 50-call turn with 20 reactions, end to end in the toy | 28 µs per model call (510 selects, 20 runs) |

Before every model call, the runner costs microseconds, against seconds of model latency. The equal-result case is dominated by serializing the new entries once.

### Compared with today

- **Per-delta dispatch goes away.** Today every published event, each delta included, waits on eight dispatchers in turn. Reactions are evaluated only after commits.
- **Connection replays go away.** Connection resolvers re-run before every model call today. They become slots that re-run only when their selection changes.
- **Per-call resolvers get cheaper.** Instead of a full `step.started` resolver before every model call, a cheap `select` runs, and `resolve` only on a change. Session-level tool and model resolvers gain that one `select`.

### Costs to manage

- **Selections that scan history** are quadratic over a long turn. In the prototype, with tiny messages, that took about 16 ms in total over 5,000 calls, against 0.01 ms with an aggregate in the view. Aggregates for common facts (attachments, usage, successful calls by tool) and a development time budget per `select` keep it in check.
- **Tool changes mid-turn miss the prompt cache.** eve's Anthropic cache breakpoint sits at the end of the tools block (`harness/prompt-cache.ts`). Equal re-runs change nothing, and presenting rare changes differently would keep them cheap ([Open questions](#open-questions)).
- **Churn.** Development mode warns about a reaction that re-runs at most of its evaluations.
- **Redeploys** re-run every reaction in every active session at its next evaluation, spread over those sessions' next turns. The external calls still happen. A code fingerprint per reaction would re-run only what changed.
- **Restores** call `resolve` for slots with code. Rebuilding lazily, when a call first needs the code, keeps cold steps cheap.
- **Storage** is one slot per reaction, plus older ones while calls that started under them are open. Selections are stored whole only for entries with code, under a cap (4 KiB in the prototype). Entries ride the checkpoint and never reach the stream.

Not measured: Workflow step overhead, checkpoint serialization, real resolver I/O, and the cost of keeping views immutable in eve's fold.

## Compatibility

Every dynamic resolver and memory provider changes shape. The change aims to ship in the same release as the event break ([`session-event-lifecycle.md`](./session-event-lifecycle.md#compatibility-at-the-break)), so authors migrate once. It's the last PR of the break, so if it isn't ready, the break ships without it and the API follows in a later release.

- **A codemod keeps today's timing:** `session.started` maps to no `select`, `turn.started` to the turn's ID, and `step.started` to the requested run's ID.
- **Not every resolver converts mechanically.** About half of the roughly 210 files that use `defineDynamic` read `ctx` in a handler, by a rough grep. The codemod moves simple reads into the selection (`auth.current` at session start becomes `auth.initiator`) and leaves a TODO for the dozen or so that read `ctx.messages`. It can't know what data outside eve a resolver depends on.
- **Memory providers:** `recall` and `tools` become `{ select, resolve }`, with recall selecting the turn's ID to keep today's timing. `compaction.completed` recall goes away, and `capture` receives only messages it hasn't seen.
- **Hooks and channels:** `select` and `resolve` are additive, and `ctx.cancel()` becomes a returned `cancel(…)`. If the channel change is adopted, handlers move to `(fact, ctx)` with v27's renames.
- **Dynamic fields become dynamic files:** `defineAgent({ model: defineDynamic(…) })` becomes a dynamic `agent.ts` returning `defineAgent({ model })`, the shape dynamic subagents already have.
- **One ordering change is already made in the pipeline PR:** memory now runs after hooks, so a hook that cancels the turn from `turn.started` also stops recall for that turn.
- **The old shape fails the build** with an error that points at the codemod, not an alias. Reactions get the typed view instead of an `unknown` event.
- **Running sessions don't cross the break,** so slots can change shape there. If the API ships later, results recorded under today's keys count as stale and re-run, as after a redeploy.

<details>
<summary>Migration scope</summary>

- **Extension contracts.** Retained epochs whose fixtures author `defineDynamic({ events })` are dropped with a reason: 57 for dynamic tools, 29 for instructions, 28 for skills, 9 for subagents, and 5 for connections. Each capability gets a new epoch.
- **Third-party extensions and memory providers** built against the old API break until they update.
- **In this repo:** 51 e2e fixture files and 19 framework source files that use `defineDynamic`, the file memory provider and two e2e memory fixtures, 7 docs pages, two template files, `eve-code`, and one app fixture.

</details>

## Plan

There are three steps in the overall plan ([`session-event-lifecycle.md`](./session-event-lifecycle.md#phases)). What's certain lands first. The API is the least certain part, so it's the last PR of the break.

1. **On `main`, now: the pipeline behind today's API.** One pipeline runs every participant in the fixed order, after the hooks, and builds the events today's handlers expect in one place. A table of the keys each kind accepts replaces the `ALLOWED_DYNAMIC_*` sets, and an unsupported key fails the build. It's shaped as the runner's skeleton, so step 3 changes what's evaluated, not when.

   Tests pin when today's participants run, asserting on handler calls and model input so they survive the wire change: recall before the first model call, model selection per model call and for a manual compaction, skills and instructions only at turn start, the refresh after a redeploy, and restoring a parked step's tools.

   It changes nothing for authors. HumanInput (#4342–#4344) touches the same files (`execution/session/turn-step.ts`, `harness/model-call/run.ts`, `harness/hitl/intake.ts`), so whichever lands second rebases rather than waiting.

2. **In the conversation slice: today's API on v27 commits.** The pipeline runs after the v27 commits that announce each use, from one table, instead of on v26 event types. Today's keys become names for those commits:

   | Key                    | Runs after                                                 |
   | ---------------------- | ---------------------------------------------------------- |
   | `session.started`      | The first commit with `turn.started`                       |
   | `turn.started`         | Each commit with `turn.started`                            |
   | `step.started`         | Each commit with `model.requested`                         |
   | `turn.completed`       | A commit with `turn.settled`, outcome `completed`          |
   | `compaction.requested` | A commit with `context.started` for a compaction           |
   | `compaction.completed` | A commit with `context.settled` for a completed compaction |

   A handler's first argument is typed `unknown`. The only readers in the repo take the turn's ID (`models/auto.ts`) and its sequence (an e2e instruction fixture), so a minimal private payload with those fields stands in for the event. Durable keys stay as they are.

3. **At the top of the integration branch: the API.** It adds:
   - `select` and `resolve` for every surface, with entries and slots in place of today's session, turn, and step metadata;
   - the memory reshape;
   - `defineDynamic` wrapping whole definitions, including a dynamic `agent.ts`;
   - hooks, with `cancel(…)` as the first intent;
   - restores from recorded selections, and the development checks;
   - typed entry points and the selectors reactions need;
   - the build errors, the codemod, the repo migration, the docs, and the tests.

   It deletes the private payload, the redeploy refresh, and the callback rebind paths. If it isn't ready, the break merges without it ([Compatibility](#compatibility)).

**Size:** a small net reduction, not measured. The three steps remove a few hundred lines of dispatch and synthetic-event code (`turn-event-handler.ts`, `resolver-events.ts`, `memory-event-lifecycle.ts`, and the filtering in the six lifecycle files). Step 3 also replaces the per-kind recording in `context/dynamic-*.ts`, about 1,600 lines, with one slot per reaction; how much goes depends on how much of the durable callback and schema replay machinery survives.

**Beyond the plan, not scheduled:**

- **The channel signature,** which would change the channel handler's arguments in `session-event-lifecycle.md`. If accepted, it belongs in the conversation slice.
- **Hooks returning more than effects and `cancel(…)`:** data, capabilities, mixed results, and other intents.
- **Clearances,** read after each `call.requested`, next to the executor's approvals decided by eve.
- **Timers, context edits, request parameters, and dynamic extension mounts.**

Each lands as a minor after the break, with its own doc and e2e tests.

## Open questions

**Semantics:**

1. **Revisions per reaction.** A redeploy re-runs every reaction in every session that takes it over, so every external source gets called. Can the bundle provide a stable fingerprint per reaction module, so only reactions whose code changed re-run?
2. **Presenting a decision versus making it.** Tools can change at any model call. [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) invalidates the whole cache when tool definitions change, and [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) recommends stable tools with `allowed_tools`. Should the harness remove tools only at turn start, and mask or append mid-turn where a provider supports it?
3. **History beyond the operational view.** `ctx.view` prunes closed calls and turns, so a selection can't count earlier deploys or failures. Should reactions declare folded aggregates that survive pruning, as `extendConversation` does for clients, or derive such facts from `ctx.messages`?
4. **Periodic refresh.** Selecting the turn refreshes every turn. "At most every ten minutes", and timers, need a committed time in the view, such as the `at` of the turn's start commit. Rows don't carry one today.
5. **Restores that rebuild something different.** An outside source may have changed since a selection was recorded, and the prototype detects the mismatch. When the rebuilt result lacks a recorded tool, or its schema differs, does the call fail, or does the recorded declaration win?
6. **The cap on stored selections.** Should it be small, like the prototype's 4 KiB, or generous, such as 64 KiB, since it bounds stored data per reaction rather than traffic per commit?
7. **Revision changes mid-turn in development.** Locally, the revision changes on every rebuild, possibly while a turn is paused. Under this proposal, the model and tools re-resolve at the next model call, everything else at the next turn, and code is rebuilt from recorded selections in between. Is that intended, or does "only while idle" need a local exception?

**Authoring:**

8. **Resolvers with several keys.** Seven in this repo, including `self-modification/agent.ts`, handle two keys whose results layer: a turn result overrides a session result of the same name. With one slot per reaction, should the codemod merge them under the turn's selection, which redoes the session work every turn, or leave a TODO?
9. **Session state read around the selection.** `resolve` runs inside the session's async context, so `defineState(...).get()` still reads state it didn't select, and one fixture (`dynamic-overwrite.ts`) writes state from a resolver. Should `resolve` run outside the session's context, or is "`resolve` reads only its selection" a documented convention? Writes also repeat when a restore calls `resolve` again.
10. **Recall after compaction.** Memoized recall no longer runs again after a mid-turn compaction, although the recalled records stay in context. Is that acceptable as the default?
11. **Build-time fields in a dynamic `agent.ts`.** `build`, `defaultTools`, `experimental`, and `tool` exposure can't vary per session. Should they sit beside `select` and `resolve`, as `build` does for dynamic subagents, or must they be static, with the compiler checking that each result agrees?

**Scope:**

12. **The channel signature.** Should channels move to `(fact, ctx)` in v27, when their event names break anyway, or in a minor after it?
13. **Intents.** Which come first after cancel, with what caps per delivery, and is `cause: {reaction}` enough attribution? Each new kind also needs the fact that satisfies it.
14. **Hooks as the public reaction.** In what order do hooks gain data, capabilities, mixed results, and other intents? Once hooks can return an entry kind, it's public contract. Do capabilities a hook declares need the same e2e coverage as their own folders?
