---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-09"
---

# Session reactions

This doc proposes one primitive, the **reaction**, underneath eve's dynamic capabilities, hooks, memory providers, and built-ins. Code references were read on `main` at `8c55ea7c1`, and the "today" examples match `main` at `0ac209c2b`. Measurements come from standalone prototypes outside this repo. Nothing in eve was changed.

## Summary

- **eve is a state machine.** Everything that happens in a session is a function of its state, and everything that happens adds to that state ([eve is a state machine](#eve-is-a-state-machine)).
- **A reaction is that idea as code.** `select` reads what it depends on, and `resolve` returns what it contributes. `resolve` is called right after the commit that changes its selection, and nothing else triggers it ([The primitive](#the-primitive)).
- **Reactions are sync or async.** Authors write sync reactions, which finish before the next commit. Async reactions, such as a model run, are a direction for eve's own loop, and aren't needed to ship this ([Sync and async reactions](#sync-and-async-reactions)).
- **Today's surfaces become sugar.** `defineDynamic`, memory providers, and hook event maps all desugar to `defineHook`, the public reaction ([Today's concepts as reactions](#todays-concepts-as-reactions)).
- **Hooks gain what has no home today:** several kinds of capability behind one condition, intents such as "compact now", agent-wide policies, and dynamic extension mounts ([Advanced examples](#advanced-examples)).
- **It's approachable now.** The session machine, state deltas, and fewer durable steps have landed on `main`, and the v27 stack makes stopping, waiting, and calls one path each ([Why this is approachable now](#why-this-is-approachable-now)).
- **It's cheap.** 20 unchanged reactions cost about 7 µs per commit ([Performance](#performance)).

The plan is unchanged. The pipeline lands on `main` behind today's API, the conversation slice moves it onto v27 commits, and the API is the last PR of the break ([Plan](#plan)).

## eve is a state machine

A session is state: the facts it has committed, folded into a view. Everything eve does is a function of that view, and everything it does commits more facts:

- **A turn starting is a fact,** and it can change which tools or skills the next model call gets.
- **When the model runs is a function of state:** a turn has started and no run is open, or every call of the last run has settled. Its response comes back as facts: content, requested calls, and a settled run.
- **A tool call runs because the view says it's requested and cleared,** and its result is a fact the next run reads.
- **A recall, a notification, or a compaction** works the same way: it reads the view, and what it produces becomes part of the view.

```text
               inputs
                 │
                 ▼
     ┌──────▶ machine ───── facts ─────┐
     │                                 ▼
   view ◀─────────── fold ────────── commit
     │                                 ▲
     └──────▶ reactions ──── slots ────┘
```

Three things change state, and each has one writer:

- **Inputs,** such as messages, approvals, and cancels, arrive from outside.
- **Facts** come only from the machine, which is pure: it does no I/O. v27 already makes it the only writer of facts ([`session-event-lifecycle.md`](./session-event-lifecycle.md)).
- **Slots** come from reactions. Each reaction writes only its own slot: the tools, skills, context, data, or intents it currently contributes ([Slots](#slots)).

Folds are the only way anything becomes state, so the model call, context assembly, and the machine all just read the view.

**The loop always settles.** After each commit, every reaction is evaluated once, in a fixed order, and `resolve` runs only when its selection changed. Slot changes alone don't re-run reactions: only new facts do, and the machine writes facts only when one of its rules applies. An intent stays satisfied once a fact satisfies it. So after any input, the session reaches a state where nothing changes, and it waits.

**Non-goals:**

- **No full session log.** Reactions need entry-shaped commits, not private entries as the source of truth. The view grows instead.
- **No public async reactions.** They're eve's own machinery.
- **No separate `defineReaction`.** `defineHook` is the public reaction.

<details>
<summary>Why change: what today's surfaces cost</summary>

Four authoring surfaces react to a session (dynamic resolvers, memory providers, hooks, and channels), and so do about a dozen built-ins. Each has its own dispatch, timing, recording, and replay:

| Surface                                                            | Code                                                                                                   | When it runs                                                                   | Where results live                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Dynamic tools, model, skills, instructions, connections, subagents | Six `context/dynamic-*-lifecycle.ts` files (1,683 lines), per-kind loaders (380) and normalizers (693) | Event keys `session.started`, `turn.started`, `step.started`, allowed per kind | Session, turn, and step keys per kind. Connections nowhere, so they re-run |
| Memory                                                             | `context/memory-lifecycle.ts` (522), `memory-event-lifecycle.ts` (76)                                  | Four event keys                                                                | Step-local prepare and drain keys; session state                           |
| Hooks and channels                                                 | `public/definitions/`, the publisher                                                                   | Every event they key; `*` hooks also get progress                              | Nothing                                                                    |
| Built-ins                                                          | Spread across `harness/` and `execution/`                                                              | Special cases                                                                  | Ad hoc keys                                                                |

- **Events that never happened.** `harness/session-machine/resolver-events.ts` hand-builds `session.started`, `turn.started`, and `step.started` to drive resolvers for model selection, redeploy refreshes, callback rebinds, connection rehydration, and parked-step restores.
- **Keys fix when, not what.** A `session.started` resolver that reads the caller keeps the first caller's answer for the whole session.
- **Per-event dispatch.** For every event a turn publishes, deltas included, `turn-event-handler.ts` awaits memory, hooks, and six resolver kinds in turn. Connection resolvers re-run before every model call.
- **Duplicated machinery:** durable keys per scope (3 copies plus 2 inline variants), revision refresh (2), name qualification and collision checks (3 each), allowed-event sets (in all six files, one duplicated in the compiler), and settle-and-log (5, each with a different failure rule). About 30 of the 78 context keys in non-test source belong to participants.
- **Built-ins that are reactions in disguise:** skill and connection announcements, the tasks and pending-approval notes, the compaction trigger, memory canonicalization, the auto model, and task cards.

</details>

## Slots

A slot holds a reaction's current contribution: the latest result of its `resolve`, such as a set of tools, a recalled note, or an intent. Each reaction has one slot, named by its file, and readers fold every slot when they read. Together with what's folded from facts, the slots make up the session view:

```text
session view
├─ folded from facts: public, on the stream
│    turns · runs · calls · tasks · interactions · messages · latest positions
└─ slots: private, in the checkpoint, one per reaction
     reaction                current contribution             read by
     skills/team_playbook    the team_playbook skill          turn start
     tools/query             orders, users                    every model call
     memory/notes (recall)   3 recalled notes, as context     every model call
     memory/notes (capture)  cursor at message 42, as data    its own next run
     hooks/csv-import        preview_rows                     every model call
                             after_import, a compact intent   the machine
     hooks/notify            nothing                          —
```

Each slot also keeps a digest of the selection that produced it, so eve knows when to call `resolve` again.

Reactions write to slots, and facts come only from the machine, for four reasons:

- **A contribution describes the present.** A fact records something that happened, once. "These tools are available" stays true until it changes, so as facts it would need added and removed events, and every reader would diff them to find what's current. A slot is replaced whole, so withdrawing something means leaving it out.
- **Reactions can run again.** Restores, redeploys, and retries may call `resolve` a second time. In a slot, an equal result changes nothing; as a fact, it would repeat history. When a reaction wants something to happen once, such as a compaction, it declares an intent, and the machine records the fact.
- **One decider keeps facts consistent.** The machine is pure, checks its rules before it writes, and can refuse, for example after the session has closed or past a cap. Reactions do I/O, so any facts they wrote would depend on whatever an outside call returned.
- **Facts are public, and slots are private.** Facts are the v27 stream that clients, channels, and evals read. Slots hold code, recalled context, and selections that can include auth. They ride the checkpoint, never reach the stream, and can change shape without breaking a client.

A slot change is still an entry: the `capabilities.changed` entry from the session-log sketch ([`session-event-lifecycle.md`](./session-event-lifecycle.md#toward-a-session-log)). Only new facts start another round of reactions, which is why the loop settles.

## Sync and async reactions

Everything in the loop has the same shape: notice something in the view, do some work, contribute the result. What differs is whether the work finishes before the next commit.

|            | Sync                                                   | Async                                                      |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Written by | Authors and eve                                        | eve only                                                   |
| Instances  | One                                                    | One per key: a requested model run, a cleared call         |
| Runs       | To completion before the next commit                   | Across commits, concurrently                               |
| Output     | Its slot                                               | An outcome in its slot, which the machine turns into facts |
| Withdrawal | The slot is replaced                                   | The work is aborted when its key leaves the selection      |
| Examples   | `defineDynamic`, hooks, memory, the compaction trigger | Model runs, tool execution                                 |

**This doc is mostly about authored sync reactions.** eve doesn't need to rebuild its loop on reactions to ship them. The harness keeps running model calls and tools as it does today, and reads slots where it reads resolver results now. Async reactions are recorded here so that nothing in the sync design rules them out.

<details>
<summary>The loop as async reactions, and how it maps to Workflow</summary>

A prototype modeled a session whose whole loop is about 100 lines of machine rules plus two async reactions, one keyed per model run and one per call. Seven scenarios pass: an approval accepted and declined, a cancel mid-call, a restart mid-run and mid-call, a restore after the session settled, and a second turn.

- **Waiting is "not selected yet".** A call that needs approval isn't in the executor's selection until its interaction settles accepted, so there's nothing to suspend and resume.
- **Cancelling is a key leaving a selection.** The stopping turn's call is aborted, and its late result never reaches the log.
- **One restart rule.** A key that's still selected without an outcome was cut off, and the machine settles it `abandoned`, v27's outcome for "a retry superseded the attempt". A run is asked again; a call isn't re-run.

On Workflow, the layers stay as they are today:

- **The workflow body stays a thin, deterministic loop** over the session inbox, as in `execution/session/program.ts`.
- **A step restores the checkpoint, applies one input, and runs everything in process:** sync reactions, the machine, and async instances as concurrent promises. It ends when nothing in process can make progress, or at a bound such as one model outcome per step. That's today's batching rule, generalized: `turnStep` already ends a batch before waiting for input, authorization, or coordination, and `modelCallsPerStep` sets the bound.
- **Work that outlives a step runs as a host,** in its own workflow run, as workflow tools and subagents do today.
- **Commit counts don't matter; step counts do.** Stream writes happen once per commit with facts, and slot-only commits ride the checkpoint. Recording slot changes with the next commit took the prototype's approval turn from 25 commits to 14, with the same 11 stream lines.

Two pieces are still open. A retried step must fold the stream lines written after its checkpoint before deciding anything, or it re-decides facts that are already public. And a cancel has to reach a running step as a signal, as steering does today through `steeringSignal`.

</details>

## Why this is approachable now

Most of what reactions need has landed on `main` in the last few weeks, or is in review as the first tier of the v27 stack. The proposal mostly connects pieces that already exist.

<details>
<summary>The refactors, on `main` and in review</summary>

**Already on `main`:**

| Change                                                                 | What reactions get from it                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The session machine (#4177, 2026-10-06)                                | The machine half already exists. Transitions in `harness/session-machine/` are functions of a `SessionView` that return a `Transition` ("Nothing else changes session state"), and lifecycle is derived from published events into a stored projection. Reactions add the other half: slots folded into the same view |
| State deltas from steps (#3988)                                        | Steps return a structural diff instead of the whole session, and a mid-session step output dropped to about 700 bytes. Slot changes ride the same delta, so they don't grow replay                                                                                                                                    |
| History kept out of steps that don't use it (#4128)                    | The session cursor separates history from context and session state, and the types prove which steps read history. Slots live in session state, so evaluating reactions doesn't pull history into a step                                                                                                              |
| Fewer durable steps (#4188) and the compaction handoff (#4239)         | Step count and event-log growth are already managed budgets. Reactions add no steps: they run inside the steps that commit                                                                                                                                                                                            |
| Compaction summaries as model calls (#4550, on #4546's model profiles) | One model-call path, so a summary run reads the model slot like any other model call                                                                                                                                                                                                                                  |
| Long work as tasks (#3840, #3850)                                      | `task.started` and `task.settled` are facts, and tasks are the hosts async reactions would need for work that outlives a step                                                                                                                                                                                         |
| Hooks that cancel turns (#3718)                                        | Hooks already steer the loop, so returning `cancel(…)` instead of calling `ctx.cancel()` is a small step                                                                                                                                                                                                              |
| `transcriptReducer` in `eve/client` (#4482)                            | Clients already fold the stream into state, the pattern this doc applies inside the session                                                                                                                                                                                                                           |

**In review, as Tier 0 of the v27 stack.** Each PR is open and stacked on the one before:

- **#4532, one projection for internal readers:** every internal reader uses the session projection, the view reactions select from.
- **#4541, one participant pipeline:** step 1 of the [Plan](#plan). Every participant runs in one fixed order, and its tests pin today's timing.
- **#4543, one stop path:** every run stops the same way. That's where a returned `cancel(…)` lands, and where an async reaction's abort would go.
- **#4545, one suspension:** a turn pauses on one record with one waiter, so waiting is one thing to select.
- **#4549, one executor:** every local call runs through one executor, the shape of the call reaction in [Sync and async reactions](#sync-and-async-reactions).
- **#4588, one running-work record:** tasks and the workflow runs a turn waits on live in one `eve.work` record.

Tier 1 (#4564, #4567, #4574, #4591) commits each transition as one v27 line, with the machine as the only writer of facts, and hands authored channels and dynamic resolvers v27 facts. Hooks, channels, and dynamic resolvers already change shape in that break, so authors migrate once ([Compatibility](#compatibility)).

</details>

**What's left is the reaction layer itself:** slots and the runner, the authoring API and its codemod, and rebuilding durable callbacks from recorded selections. None of it needs new Workflow machinery.

## The primitive

### `select` and `resolve`

```ts
interface Reaction<S extends Json> {
  select?(view: SessionView, ctx: SelectContext): S;
  resolve(selected: S, ctx: ResolveContext): Result | Promise<Result>;
}
```

That's the whole primitive, and `defineHook` is its public form.

- **`select` declares the inputs.** It's synchronous and deterministic, and returns JSON. Omitting it means `resolve` runs once. Development mode evaluates it twice to catch clock reads.
- **`resolve` gets the selection, not the view,** so it can't depend on state it didn't select. Its context adds services: `abortSignal`, the reaction's previous slot as `ctx.previous` (for cursors and counters), and the facts of the commit that called it as `ctx.facts`.
- **IDs come from file paths,** like every other eve name.

### Why `select` is separate

A single `(view) => output` function would need an `if` that asks "has this changed since last time?", and answering that means remembering the previous answer. `select` is that `if`, moved to where eve can run it on its own and remember the result. It's the boundary between what eve can run freely (cheap, pure, often) and what it should run sparingly (I/O, effects, code):

- **Effects fire on a change,** not on every commit that matches.
- **I/O runs when its inputs change,** not at every use.
- **Restores rebuild old decisions** from the recorded selection. Without one, eve would need the old view, which means a full log.
- **Development checks can run `select` twice,** because it's pure.

<details>
<summary>Ways to keep one function, and why not</summary>

- **Tracked reads,** in the style of MobX or Salsa: eve records what the function read and re-runs when any of it changes. It sees raw reads, not derived values, so "has an image" re-runs at every message because it reads `messages.length`. Fixing that takes memoized intermediate derivations, which is `select` again with more machinery. It also hides dependencies, and the recorded reads can be large and include auth data.
- **An inline memo,** like React's `useMemo`: `(view, ctx) => ctx.memo(key, () => fetchTools())`. It reads as one function, but it's the same split, with the outer part required to be pure and synchronous and every memo call needing a stable identity for restores. Those are React's rules of hooks.

</details>

### When `resolve` is called

**Right after the commit that changed its selection,** for every reaction. Each reader then folds whatever slots exist when it reads them: tools and the model at every model call, skills and instructions at turn start. The timing of each kind is the reader's policy, not the reaction's.

- **Calling right away gives the same answers as waiting for a read,** because `resolve` sees only its selection. In a prototype simulation where a selection flips between reads, waiting saved runs (2 instead of 6) but never changed an answer.
- **A commit's reactions finish before the next commit,** so the machine sees their slots when it writes the next fact, such as `model.started` after `model.requested`.
- **One fixed order after each commit:** hooks and channels, then memory, the model, connections, subagents, tools, skills, and instructions. A reaction may select earlier slots and never later ones, so there's no dependency graph, and a mode a hook declares is visible to every capability.

### What `resolve` returns

**The latest result is the reaction's current state.** It replaces the slot, so anything missing from the new result is withdrawn. Returning nothing keeps the slot, and `null` clears it.

A result is one definition, a map of named definitions, or entries such as intents and data. A slot folder names a single definition after the file, and a map names each entry by its key, as today. Each kind is read by eve's code for that kind:

| Entry                          | Read by, and when                                                                       | If `resolve` throws                                 |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| A model and agent settings     | The next model call                                                                     | Fails the turn                                      |
| Tools                          | Every model call: validated, named, and merged across slots                             | Omitted and logged                                  |
| Skills, subagents, connections | Captured at turn start, for the turn                                                    | Omitted and logged; a connection parks, as today    |
| Instructions                   | System role: replaced per slot. User role: appended when a new selection resolves to it | Contributes nothing, and never keeps an older value |
| Context (recall, notes)        | Every model call                                                                        | The surface's rule; recall fails the turn           |
| Data                           | Other reactions, through `select`                                                       | Logged                                              |
| Intents                        | The machine, after the commit                                                           | Withdrawn, so never acted on                        |

- **There are no deltas.** The whole result replaces the slot, the way React's render returns the full tree.
- **Names are scoped by kind,** and two reactions declaring the same name is an error, as today.
- **Equal results change nothing.** Results are compared serialized, so a re-run that returns the same tools doesn't commit a slot change.

### Intents

An intent is an entry the machine reads: a standing wish, such as "a compaction is wanted". The machine acts on it once, because it checks its own facts, the way a Kubernetes controller compares desired state with what has happened. **An intent counts from the slot change that added it, and is satisfied by the first matching fact after that:**

| Intent              | Key                                | Satisfied by                                                      |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| Compact             | The trigger, such as `"threshold"` | The next `context.started` for a compaction                       |
| Continue            | The turn it follows                | A `turn.started` this reaction caused after that turn             |
| Cancel              | The turn                           | That turn's `turn.settled`                                        |
| Require approval    | The call                           | `interaction.opened` for that call; it runs only if it's accepted |
| Open an interaction | The interaction's key              | `interaction.opened` with that key                                |
| Start a task        | The task's key                     | `task.started` with that key                                      |

- **The key sets the scope of "once".** `compact("after_import")` compacts once, and a key that includes a count compacts once per count.
- **Withdrawing is leaving it out.** An intent that's gone from the slot before the machine acts on it is cancelled.
- **No loops, and no queue.** A slot changes only when its selection does, and a satisfied intent stays satisfied, so retries and restores can't repeat it.
- **Only the machine writes facts,** and it can refuse, for example after the session has closed. A turn a reaction starts carries `cause: {reaction}` and the agent's own principal, never the caller's.

<details>
<summary>The intent simulation</summary>

A prototype simulation models a compaction trigger that selects `tokens > threshold` and resolves to a compact intent or nothing:

| Scenario                                                                       | Compactions              |
| ------------------------------------------------------------------------------ | ------------------------ |
| Context grows past the threshold 6 times, and each compaction reduces enough   | 6                        |
| Compaction only gets down to 110, so 20 commits stay above the threshold       | 1                        |
| Context drops back below the threshold before the machine acts                 | 0, and the slot is empty |
| A restore between the slot change and the machine's action, then another after | 1 in total               |

</details>

### Facts are selections too

The view keeps the position of the latest fact of each type in `view.latest`, a fold of about 30 numbers, so a new fact is an ordinary change in a selection. Select an identity, not a count: two commits that each settle one call have the same count, and in a prototype simulation counting missed one of five settles.

Hook `events` maps and channel handlers are typed sugar for this ([Hooks](#hooks)). Restores don't fire them again, because the positions are in the view.

### What a reaction reads

**Every reaction reads the same view, conversation included.** That's the operational view v27 folds (turns, runs, calls, tasks, and interactions), the conversation as committed in `view.messages`, `view.latest`, and the slots of earlier reactions. `ctx` adds the session's identity and auth, and the surface's own context, such as `ctx.memory`. Selectors like `view.activeTurn`, `view.calls`, `view.tasks`, and `view.attachments` are proposed aggregates.

**No reaction reads the assembled model request:** the system prompt, instruction results, recall, and other context contributions. The request is built from reactions' slots, so reading it would make a reaction depend on itself and on the order reactions are evaluated in. Today's `ctx.messages` mixes the two, which is where the order rules in the dynamic capabilities guide come from.

A subagent's reactions see only the subagent's session, as hooks do today.

### Failures, restores, and redeploys

- **A throw withdraws the slot,** then the kind's rule applies (the last column of the entries table). A `select` that throws or returns something that isn't JSON counts as a throw.
- **Effects are at least once,** keyed by `ctx.position`.
- **What's stored is small:** the slot and a digest of the selection. Entries with code, such as tools and connections with token callbacks, also store the full selection, under a cap, which a restore passes back to `resolve` to rebuild the code. Otherwise restores reuse slots as they are, and auth attributes in other selections are never persisted.
- **Redeploys re-resolve after the first commit under the new revision.** Nothing replays an event.
- **Calls keep the entries they started under.** A parked call's tools come from the slot recorded at its model call.

<details>
<summary>The runner, condensed from a prototype</summary>

```ts
async function afterCommit(commit: Commit, s: Session): Promise<void> {
  for (const r of s.reactions) {
    const selection = r.select?.(s.view, s.selectContext(r)) ?? null;
    const digest = hash(canonical(selection));
    const slot = s.slots.get(r.id);
    if (slot?.revision === r.revision && slot.digest === digest) continue; // reuse
    const result = await guard(r, () => r.resolve(selection, s.resolveContext(r, commit)));
    // Later reactions in this pass see the new slot; an equal result commits nothing.
    s.replaceSlot(r, { result, digest, selection: hasCode(result) ? selection : undefined });
  }
  s.machine.reconcile(s.view); // acts on intents that aren't satisfied yet
}
```

The runner and fact dispatch were about 120 lines in the prototype, before eve's validation, durable callbacks, and merging.

</details>

## Today's concepts as reactions

Each example shows today's code, the proposed form, and the hook it desugars to. **`defineDynamic` is a hook in its definition's own folder,** named by its file, and it wraps exactly what the file would export statically.

### Dynamic capabilities

#### A skill for the caller's team

Today, the event key decides when the resolver runs, so it keeps the first caller's team for the whole session:

```ts
// agent/skills/team_playbook.ts
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const team = ctx.session.auth.current?.attributes.team;
      const markdown = team ? PLAYBOOKS[team] : undefined;
      return markdown ? defineSkill({ markdown }) : null;
    },
  },
});
```

Proposed, it names what it depends on, so it follows the current caller:

```ts
// agent/skills/team_playbook.ts
export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.team ?? null,
  resolve: (team) => (team && PLAYBOOKS[team] ? defineSkill({ markdown: PLAYBOOKS[team] }) : null),
});
```

As a hook, the file's name becomes an explicit key:

```ts
// agent/hooks/team_playbook.ts
export default defineHook({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.team ?? null,
  resolve: (team) =>
    team && PLAYBOOKS[team] ? { team_playbook: defineSkill({ markdown: PLAYBOOKS[team] }) } : null,
});
```

To keep today's once-per-session behavior, select `ctx.session.auth.initiator` instead.

#### Tools from external data

Today, the table list is fetched once per session:

```ts
// agent/tools/query.ts
export default defineDynamic({
  events: {
    "session.started": async () =>
      Object.fromEntries((await listTables()).map((t) => [t.name, tableTool(t)])),
  },
});
```

Proposed, selecting the latest turn start refreshes it once per turn. With no `select`, it runs once, as today:

```ts
// agent/tools/query.ts
export default defineDynamic({
  select: (view) => view.latest["turn.started"] ?? null,
  resolve: async (_turn, { abortSignal }) =>
    Object.fromEntries(
      (await listTables({ signal: abortSignal })).map((t) => [t.name, tableTool(t)]),
    ),
});
```

As a hook, it's the same function in `agent/hooks/query.ts`, since the map already names each tool.

#### The model, from the conversation

Today, the model is a dynamic field, and its resolver runs before every model call:

```ts
// agent/agent.ts
export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) =>
        ctx.messages.some(hasImage) ? "google/gemini-3.5-flash" : "zai/glm-5.2",
    },
  }),
});
```

Proposed, `agent.ts` is dynamic as a whole, the same shape a dynamic subagent's `agent.ts` already has. `resolve` runs once, when the first image arrives:

```ts
// agent/agent.ts
export default defineDynamic({
  select: (view) => view.messages.some(hasImage),
  resolve: (image) => defineAgent({ model: image ? "google/gemini-3.5-flash" : "zai/glm-5.2" }),
});
```

Agent settings have one writer, the agent's own `agent.ts`, so this desugars to an internal reaction rather than a public hook:

```ts
reaction({
  select: (view) => view.messages.some(hasImage),
  resolve: (image) => [agentSettings({ model: image ? "google/gemini-3.5-flash" : "zai/glm-5.2" })],
});
```

- **Dynamic fields go away.** A field can't express absence, and returning the whole agent lets `modelOptions` travel with the model it's for. Today the dynamic model form forbids them.
- **Select the fact, not the data.** `some(hasImage)` changes once, while `messages.length` changes at every message.

### Hooks

#### An observer

Today, a hook subscribes to events:

```ts
// agent/hooks/notify.ts
export default defineHook({
  events: {
    "turn.completed": async (event, ctx) => notifyOwner(ctx.session.id, event.data.turnId),
  },
});
```

Proposed, the event map stays, with v27's names:

```ts
// agent/hooks/notify.ts
export default defineHook({
  events: {
    "turn.settled": async (fact, ctx) => {
      if (fact.data.outcome === "completed") await notifyOwner(ctx.session.id, fact.data.turnId);
    },
  },
});
```

The map desugars to a selection of the latest position, with the commit's facts dispatched to the handler:

```ts
export default defineHook({
  select: (view) => view.latest["turn.settled"] ?? null,
  resolve: async (_position, ctx) => {
    for (const fact of ctx.facts) {
      if (fact.type === "turn.settled" && fact.data.outcome === "completed") {
        await notifyOwner(ctx.session.id, fact.data.turnId);
      }
    }
  },
});
```

A hook can also select state instead of a fact. `select: (view) => idle(view)` notifies once each time the session goes idle, whichever fact ended the work. Today that's a check in whichever handler you guess ends it.

#### A gate

Today, a hook calls `ctx.cancel()`:

```ts
// agent/hooks/require-credentials.ts
export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      if (!(await hasCredentials(ctx.session.auth.current))) ctx.cancel();
    },
  },
});
```

Proposed, it returns a cancel intent, and `ctx.cancel()` goes away:

```ts
export default defineHook({
  events: {
    "turn.started": async (fact, ctx) =>
      (await hasCredentials(ctx.session.auth.current))
        ? null
        : cancel(fact.data.turnId, "Sign in first"),
  },
});
```

As a reaction:

```ts
export default defineHook({
  select: (view, ctx) =>
    view.activeTurn
      ? { turnId: view.activeTurn.id, caller: ctx.session.auth.current?.principalId }
      : null,
  resolve: async (turn) =>
    turn && !(await hasCredentials(turn.caller)) ? cancel(turn.turnId, "Sign in first") : null,
});
```

### Memory

Today, a provider has handlers keyed by lifecycle points:

```ts
// agent/lib/notes-memory.ts
export const notesMemory = () =>
  defineMemoryProvider({
    recall: {
      "turn.started": (ctx) => searchNotes(ctx.memory.scope.key, ctx.turn.input),
    },
    capture: {
      "turn.completed": (ctx) => saveNotes(ctx.memory.scope.key, ctx.messages, ctx.operationId),
    },
    tools: (ctx) => ({ forget: forgetTool(ctx.memory.scope.key) }),
  });
```

Proposed, recall and tools are `select` plus `resolve`, and capture receives only messages it hasn't seen:

```ts
// agent/lib/notes-memory.ts
export const notesMemory = () =>
  defineMemoryProvider({
    recall: {
      select: (view, ctx) => ({
        scope: ctx.memory.scope.key,
        query: latestUserText(view.messages),
      }),
      resolve: ({ scope, query }, { abortSignal }) => searchNotes(scope, query, abortSignal),
    },
    capture: (messages, ctx) => saveNotes(ctx.memory.scope.key, messages, ctx.operationId),
    tools: {
      select: (_view, ctx) => ctx.memory.scope.key,
      resolve: (scope) => ({ forget: forgetTool(scope) }),
    },
  });
```

A memory slot desugars to three hooks, mounted with the slot's `ctx.memory`:

```ts
// recall: context, read at every model call
defineHook({
  select: recall.select,
  resolve: async (selected, ctx) => context("notes", await recall.resolve(selected, ctx)),
});

// tools: prefixed with the slot's name
defineHook({
  select: tools.select,
  resolve: async (scope, ctx) => prefix("notes", await tools.resolve(scope, ctx)),
});

// capture: a cursor in its own slot, so each message is stored once
defineHook({
  select: (view) => [view.latest["turn.settled"], view.latest["context.started"]],
  resolve: async (_positions, ctx) => {
    const fresh = ctx.messagesAfter(ctx.previous?.cursor);
    await capture(fresh, ctx);
    return data({ cursor: fresh.at(-1)?.seq ?? ctx.previous?.cursor });
  },
});
```

- **Recall runs again only when its selection changes,** and it reads the incoming message from the conversation. Today the delivery is only in `ctx.turn.input`.
- **Capture runs right after the commit,** before a compaction removes anything, and providers stop deduplicating.
- **Isolation by construction:** a recall that doesn't select the scope can't query with it.

<details>
<summary>Built-ins as reactions</summary>

The same primitive covers eve's own special cases, so eve is built with eve:

```ts
// The compaction trigger: an estimate kept in the view, and an intent.
reaction({
  select: (view) => contextTokens(view) > compactionThreshold(view),
  resolve: (over) => (over ? [compact("threshold")] : []),
});

// The skill announcement: context computed from the skill slots.
reaction({
  select: (view) => skillNames(view),
  resolve: (names) => [context("skills", announceSkills(names))],
});
```

The tasks and pending-approval notes, connection announcements, and task cards follow the same pattern.

</details>

## Advanced examples

None of these is possible today. They're beyond the plan, and each would land with its own doc and e2e tests.

### One condition, several kinds

One hook can gate several kinds of capability behind one condition, instead of three files with the same `select`:

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

Each entry applies when its kind is read: the tool at the next model call, and the skill and instructions from the next turn.

### Tools and an intent

While a CSV is attached, this hook offers tools to preview and import it. Once an import succeeds, it withdraws the import tool and asks for a compaction to drop the bulky previews:

```ts
// agent/hooks/csv-import.ts
export default defineHook({
  select: (view) => ({
    hasCsv: view.attachments.some((file) => file.mediaType === "text/csv"),
    imported: view.calls.some((c) => c.name === "import_rows" && c.outcome === "completed"),
  }),
  resolve: ({ hasCsv, imported }) => {
    if (!hasCsv) return null;
    if (!imported) return { preview_rows: previewRows, import_rows: importRows };
    return {
      preview_rows: previewRows,
      after_import: compact({ reason: "Summarize the row previews." }),
    };
  },
});
```

The compaction happens once, because the `context.started` that satisfies it stays in the view. If compacting doesn't shrink the context much, nothing asks again.

### An agent-wide policy

Today, approval is set per tool or per connection, so "anything touching production needs approval" is repeated on each one. One hook can apply it to every call:

```ts
// agent/hooks/production-approvals.ts
export default defineHook({
  select: (view) =>
    view.calls
      .filter((c) => c.status === "requested" && c.input?.env === "production")
      .map((c) => c.id),
  resolve: (callIds) =>
    Object.fromEntries(
      callIds.map((id) => [id, requireApproval(id, { reason: "Production change" })]),
    ),
});
```

Returning the whole set each time is fine, because the machine reconciles each intent by its key.

### A dynamic extension mount

A mount file exports what the extension returns, so `defineDynamic` applies to it like any other file:

```ts
// agent/extensions/crm.ts
export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.plan === "enterprise",
  resolve: (enterprise) => (enterprise ? crm({ apiKey: process.env.CRM_API_KEY! }) : null),
});
```

Today a mount is static: `export default crm({ apiKey })`. A dynamic mount is read at turn start and gates only session-scoped pieces, such as tools, skills, instructions, connections, and subagents. Channels, routes, and schedules stay global.

### More that falls out

| Behavior                                                                                     | The hook returns                                                | Today                                                 |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| Modes: one hook decides "read-only" or "plan", and tools, approvals, and the model follow it | Data that later reactions select                                | Each resolver recomputes its own condition            |
| Context from state mid-turn: "80% of the budget is used", "deploy failed twice"              | Context, read before each model call                            | Contributions only at turn start and after compaction |
| Follow-up turns                                                                              | A continue intent                                               | Not possible                                          |
| Derived state, exactly once: counters, todo lists, cost per tool                             | Data                                                            | Hooks write `defineState` with at-least-once delivery |
| Explaining decisions: "tools changed at r6 because `deployed` went from false to true"       | Nothing new: slots and their recorded selections already say it | Not possible                                          |
| Context edits: drop stale tool outputs, redact across tools                                  | Context edits, a new entry kind                                 | Only compaction rewrites history                      |
| Timers per session: remind about an open approval, expire a grant                            | A wake-up intent, which needs committed time in the view        | A once-a-minute schedule over an application store    |
| Request shaping: reasoning effort, cache breakpoints, masking tools                          | Request parameters, a new entry kind                            | Only the model is dynamic                             |

## Performance

These numbers come from a prototype on an 8-core Xeon (2.9 GHz) with Node 24. They exclude user code, so a resolver's own I/O comes on top.

| Case                                                    | Cost                                        |
| ------------------------------------------------------- | ------------------------------------------- |
| 20 reactions evaluated together, none changed           | 7 µs per evaluation                         |
| One reaction re-run whose 5 tools come back equal       | 48 µs                                       |
| 10 hooks after a commit                                 | 15 µs                                       |
| A 50-call turn with 20 reactions, end to end in the toy | 28 µs per model call (510 selects, 20 runs) |

The runner costs microseconds after each commit, against seconds of model latency. The end-to-end case was measured with reactions evaluated only before reads. Evaluating after every commit adds one `select` per reaction per commit, about 0.35 µs each at the first row's rate.

**Compared with today:**

- **Per-delta dispatch goes away.** Today every published event, each delta included, waits on eight dispatchers in turn. Reactions are evaluated only after commits.
- **Connection replays go away.** Connection resolvers re-run before every model call today. As slots, they re-run only when their selection changes.
- **Per-call resolvers get cheaper.** Instead of a `step.started` resolver before every model call, a cheap `select` runs after each commit, and `resolve` only on a change.

**Costs to manage:**

- **Selections that scan history** are quadratic over a long turn: in the prototype, about 16 ms in total over 5,000 calls, against 0.01 ms with an aggregate in the view. Aggregates for common facts (attachments, usage, calls by tool) and a development time budget per `select` keep it in check.
- **Tool changes mid-turn miss the prompt cache.** eve's Anthropic cache breakpoint sits at the end of the tools block (`harness/prompt-cache.ts`). Equal re-runs change nothing, and presenting rare changes differently would keep them cheap ([Open questions](#open-questions)).
- **A slow `resolve` delays the next commit,** not just the next model call. If it matters, readers could wait for a slot's run in flight instead of every commit waiting for all reactions.
- **Redeploys** re-run every reaction in every active session after its next commit, so external calls still happen. A code fingerprint per reaction would re-run only what changed.
- **Storage** is one slot per reaction, plus older slots while calls that started under them are open. Selections are stored whole only for entries with code, under a cap (4 KiB in the prototype). Slots ride the checkpoint and never reach the stream.

Not measured: Workflow step overhead, checkpoint serialization, real resolver I/O, and the cost of keeping views immutable in eve's fold.

## Compatibility

Every dynamic resolver and memory provider changes shape. The change aims to ship in the same release as the event break ([`session-event-lifecycle.md`](./session-event-lifecycle.md#compatibility-at-the-break)), so authors migrate once. It's the last PR of the break, so if it isn't ready, the break ships without it and the API follows in a later release.

- **A codemod keeps today's timing:** `session.started` maps to no `select`, `turn.started` to the latest turn start, and `step.started` to the latest model request.
- **Not every resolver converts mechanically.** About half of the roughly 210 files that use `defineDynamic` read `ctx` in a handler, by a rough grep. The codemod moves simple reads into the selection (`auth.current` at session start becomes `auth.initiator`) and leaves a TODO for the dozen or so that read `ctx.messages`. It can't know what data outside eve a resolver depends on.
- **Dynamic fields become dynamic files:** `defineAgent({ model: defineDynamic(…) })` becomes a dynamic `agent.ts` that returns `defineAgent({ model })`.
- **Memory providers:** `recall` and `tools` become `{ select, resolve }`, with recall selecting the latest turn start to keep today's timing. `compaction.completed` recall goes away, and `capture` receives only messages it hasn't seen.
- **Hooks and channels:** event maps stay, with v27's names, and `select` and `resolve` are additive. `ctx.cancel()` becomes a returned `cancel(…)`. Hooks gain the conversation through the view. If the channel change is adopted, handlers move to `(fact, ctx)`.
- **One ordering change is already made in the pipeline PR:** memory now runs after hooks, so a hook that cancels the turn from `turn.started` also stops recall for that turn.
- **The old shape fails the build** with an error that points at the codemod, not an alias.
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

   Tests pin when today's participants run, asserting on handler calls and model input so they survive the wire change: recall before the first model call, model selection per model call and for a manual compaction, skills and instructions only at turn start, the refresh after a redeploy, and restoring a parked step's tools. It changes nothing for authors. HumanInput (#4342–#4344) touches the same files, so whichever lands second rebases rather than waiting.

2. **In the conversation slice: today's API on v27 commits.** The pipeline runs after the v27 commits that announce each use, from one table, instead of on v26 event types:

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
   - `select` and `resolve` for every surface, with slots in place of today's session, turn, and step metadata;
   - the view for every reaction, conversation included;
   - the memory reshape;
   - `defineDynamic` wrapping whole definitions, including a dynamic `agent.ts`;
   - hooks, with `cancel(…)` as the first intent;
   - restores from recorded selections, and the development checks;
   - the build errors, the codemod, the repo migration, the docs, and the tests.

   It deletes the private payload, the redeploy refresh, and the callback rebind paths. If it isn't ready, the break merges without it ([Compatibility](#compatibility)).

**Size:** a small net reduction, not measured. The three steps remove a few hundred lines of dispatch and synthetic-event code (`turn-event-handler.ts` at 140 lines, `resolver-events.ts` at 29, `memory-event-lifecycle.ts` at 76, and the filtering in the six lifecycle files). Step 3 also replaces the per-kind recording in `context/dynamic-*.ts`, about 1,600 lines, with one slot per reaction. How much goes depends on how much of the durable callback and schema replay machinery survives.

**Beyond the plan, not scheduled.** Each lands as a minor after the break, with its own doc and e2e tests:

- hooks returning more than effects and `cancel(…)`: data, capabilities, mixed results, and other intents, including `requireApproval`;
- dynamic extension mounts;
- timers, context edits, and request parameters;
- the channel signature, which would belong in the conversation slice if accepted;
- async reactions for eve's own loop.

## Open questions

**Semantics:**

1. **Revisions per reaction.** A redeploy re-runs every reaction in every session that takes it over, and locally the revision changes on every rebuild, possibly mid-turn. Can the bundle provide a stable fingerprint per reaction module, so only reactions whose code changed re-run?
2. **Presenting a decision versus making it.** Tools can change at any model call. [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) invalidates the whole cache when tool definitions change, and [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) recommends stable tools with `allowed_tools`. Should the harness remove tools only at turn start, and mask or append them mid-turn where a provider supports it?
3. **History and time beyond the operational view.** The view prunes closed calls and turns, so a selection can't count earlier deploys, and nothing in it carries a committed time for "at most every ten minutes" or timers. Should reactions declare folded aggregates that survive pruning, and should commits carry an `at`?
4. **Restores that rebuild something different.** An outside source may have changed since a selection was recorded. When the rebuilt result lacks a recorded tool, or its schema differs, does the call fail, or does the recorded declaration win?
5. **The cap on stored selections.** Small, like the prototype's 4 KiB, or generous, such as 64 KiB, since it bounds stored data per reaction rather than traffic per commit?

**Authoring:**

6. **Resolvers with several keys.** Seven in this repo, including `self-modification/agent.ts`, handle two keys whose results layer: a turn result overrides a session result of the same name. Should the codemod merge them under the turn's selection, which redoes the session work every turn, or leave a TODO?
7. **Session state read around the selection.** `resolve` runs inside the session's async context, so `defineState(...).get()` still reads state it didn't select, and one fixture (`dynamic-overwrite.ts`) writes state from a resolver. Should `resolve` run outside the session's context, or is "`resolve` reads only its selection" a documented convention?
8. **Build-time fields in a dynamic `agent.ts`.** `build`, `defaultTools`, `experimental`, and tool exposure can't vary per session. Should they sit beside `select` and `resolve`, as `build` does for dynamic subagents, or must they be static?
9. **Recall after compaction.** Memoized recall no longer runs again after a mid-turn compaction, although the recalled records stay in context. Is that acceptable as the default?

**Scope:**

10. **The channel signature.** Should channels move to `(fact, ctx)` in v27, when their event names break anyway, or in a minor after it?
11. **Intents.** Which come first after `cancel`, with what caps per delivery, and is `cause: {reaction}` enough attribution? Each new kind also needs the fact that satisfies it.
12. **Hooks as the public reaction.** In what order do hooks gain data, capabilities, mixed results, and other intents? Once hooks can return an entry kind, it's public contract. Do capabilities a hook declares need the same e2e coverage as their own folders?
13. **Async reactions.** Does eve's loop move onto them, and when? On Workflow they need a retried step to catch up from the stream, and a cancel to reach a running step.
