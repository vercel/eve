---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-10"
---

# Session reactions

This doc proposes one primitive, the **reaction**, underneath eve's dynamic capabilities, hooks, memory providers, and built-ins. Code references were read on `main` at `8c55ea7c1`, and the "today" examples match `main` at `0ac209c2b`. The performance measurements come from standalone prototypes outside this repo.

**A prototype in eve is open as [#4616](https://github.com/vercel/eve/pull/4616)**, on the v27 clients PR (#4602). It deletes the event-bound lifecycles and the durable callback machinery, and runs every dynamic capability, memory, and hooks on one runner. Review of this doc and of the prototype settled several questions, and the sections below say where the prototype decided differently from the first draft. The decisions about `defineDynamic`, including why the AST transforms are gone, are in [`dynamic-values.md`](./dynamic-values.md).

## Summary

- **eve is a state machine.** Everything that happens in a session is a function of its state, and everything that happens adds to that state ([eve is a state machine](#eve-is-a-state-machine)).
- **A reaction is that idea as code.** `select` reads what it depends on, and `resolve` returns what it contributes. `resolve` is called right after the commit that changes its selection, and nothing else triggers it ([The primitive](#the-primitive)).
- **Reactions are sync or async.** Authors write sync reactions, which finish before the next commit. Async reactions, such as a model run, are a direction for eve's own loop, and aren't needed to ship this ([Sync and async reactions](#sync-and-async-reactions)).
- **Today's surfaces become sugar.** `defineDynamic`, memory providers, and hook event maps all lower to one internal reaction. `defineDynamic` is typed by the folder it's in, and `defineHook` is the public reaction for intents and effects ([Today's concepts as reactions](#todays-concepts-as-reactions)).
- **`resolve` is a function of its selection.** It runs outside the session's context and may run again at any time, such as to rebuild code in another process. Effects go in hook `events` handlers ([The primitive](#the-primitive)).
- **Hooks gain what has no home today:** intents such as "compact now", and later several kinds of capability behind one condition, agent-wide policies, and dynamic extension mounts ([Advanced examples](#advanced-examples)).
- **It's approachable now.** The session machine, state deltas, and fewer durable steps have landed on `main`, and the v27 stack makes stopping, waiting, and calls one path each ([Why this is approachable now](#why-this-is-approachable-now)).
- **It's cheap.** 20 unchanged reactions cost about 7 µs per commit ([Performance](#performance)).

The prototype took a shorter path than the original plan: it lands the API with the v27 break directly, with no pipeline step behind today's API ([Plan](#plan)).

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

Each slot also keeps a digest of the selection that produced it, so eve knows when to call `resolve` again, and the runtime revision that resolved it. A slot whose `resolve` threw keeps the error, so it retries when its selection or the revision changes rather than on every commit. In the prototype, slots live in one durable `eve.reactions` record, beside the latest position of each fact type and the intents already satisfied.

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

**What's left is the reaction layer itself:** slots and the runner, the authoring API, and rebuilding code from recorded selections. None of it needs new Workflow machinery, and #4616 builds all three.

## The primitive

### `select` and `resolve`

```ts
interface Reaction<S extends Json> {
  select(view: ReactionView, ctx: SelectContext): S;
  resolve(selected: S, ctx: ResolveContext): Result | Promise<Result>;
}
```

That's the whole primitive. `defineDynamic` is its form for capabilities, typed by folder, and `defineHook` its form for intents and effects.

- **`select` declares the inputs.** It's synchronous and deterministic, and returns JSON. It's required: `select: () => null` resolves once. A proposed development mode evaluates it twice to catch clock reads.
- **`resolve` gets the selection, not the view,** so it can't depend on state it didn't select. Its context holds the session's identity and auth, the channel, and an `abortSignal`.
- **`resolve` is a function of its selection.** eve may call it again with the same selection at any time: to rebuild code in a fresh process, after a redeploy, or after a failure. So it runs outside the session's async context, where reading `defineState` throws, and it gets neither the commit's facts nor its own previous slot. The first draft offered both, as `ctx.facts` and `ctx.previous`. Each made `resolve` depend on something a rebuild can't reproduce.
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
- **One fixed order after each commit:** hooks and channels, then memory, the model, connections, subagents, tools, skills, and instructions. A reaction may select earlier slots and never later ones, so there's no dependency graph, and a mode a hook declares is visible to every capability. `view.model` throws in hooks, memory, and the model itself, which run before the model is chosen.
- **Streamed progress reaches hooks only.** A commit of content deltas alone runs no capability's `select`: capabilities depend on facts, and a `select` per delta would cost every stream.

### What `resolve` returns

**The latest result is the reaction's current state.** It replaces the slot, so anything missing from the new result is withdrawn. `undefined` and `null` both contribute nothing. A capability resolver whose type returns nothing (`void`) is a type error, because a missing `return` would silently withdraw everything.

A result is one definition, a map of named definitions, or entries such as intents and data. A slot folder names a single definition after the file, and a map names each entry by its key, as today. Each kind is read by eve's code for that kind:

| Entry                          | Read by, and when                                                                       | If `resolve` throws                                 |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| A model and its settings       | The next model call                                                                     | Fails the model call that needs it                  |
| Tools                          | Every model call: validated, named, and merged across slots                             | Omitted and logged                                  |
| Skills, subagents, connections | Captured at turn start, for the turn                                                    | Omitted and logged; a connection parks, as today    |
| Instructions                   | System role: replaced per slot. User role: appended when a new selection resolves to it | Contributes nothing, and never keeps an older value |
| Context (recall, notes)        | Every model call                                                                        | The surface's rule; recall fails the turn           |
| Data                           | Other reactions, through `select`                                                       | Logged                                              |
| Intents                        | The machine, after the commit                                                           | Withdrawn, so never acted on                        |

- **There are no deltas.** The whole result replaces the slot, the way React's render returns the full tree.
- **Names are scoped by kind,** and two reactions declaring the same name is an error, as today.
- **Equal results change nothing.** Results are compared serialized, so a re-run that returns the same tools doesn't commit a slot change. The slot still records the new selection, so code a fresh process rebuilds is built for the current one, for example the current tenant.

### Intents

An intent is an entry the machine reads: a standing wish, such as "a compaction is wanted". The machine acts on it once, because it checks its own facts, the way a Kubernetes controller compares desired state with what has happened. **An intent counts from the slot change that added it, and is satisfied by the first matching fact after that:**

| Intent              | Key                               | Satisfied by                                                      |
| ------------------- | --------------------------------- | ----------------------------------------------------------------- |
| Compact             | Its entry in the result           | The next `context.started` for a compaction                       |
| Continue            | The turn it follows               | A `turn.started` this reaction caused after that turn             |
| Cancel              | The turn running when it resolves | The commit that stops that turn                                   |
| Require approval    | The call                          | `interaction.opened` for that call; it runs only if it's accepted |
| Open an interaction | The interaction's key             | `interaction.opened` with that key                                |
| Start a task        | The task's key                    | `task.started` with that key                                      |

- **The key sets the scope of "once".** An intent's key is its entry in the result: `{ after_import: compact() }` compacts once, and `{ ["import-" + count]: compact() }` once per count. A single intent is keyed `"default"`. `compact({ reason })` takes no key of its own, so there's one way to name it.
- **Satisfaction is recorded.** The prototype records each satisfied key per reaction in the durable state, so an intent stays satisfied after the view prunes the fact that satisfied it. A cancel that a commit can't act on, such as a commit outside the turn, waits for one that can while its turn runs.
- **Withdrawing is leaving it out.** An intent that's gone from the slot before the machine acts on it is cancelled.
- **No loops, and no queue.** A slot changes only when its selection does, and a satisfied intent stays satisfied, so retries and restores can't repeat it.
- **Only the machine writes facts,** and it can refuse, for example after the session has closed. A turn a reaction starts carries `cause: {reaction}` and the agent's own principal, never the caller's.
- **The prototype ships `cancel` and `compact`.** The other rows are proposals.

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

**Every reaction reads the same view, conversation included.** That's the operational view v27 folds (turns, runs, calls, tasks, and interactions), the conversation as committed in `view.messages`, `view.latest`, `view.turn`, and the slots of earlier reactions. `ctx` adds the session's identity and auth, and the channel.

- **`view.turn`** is the session's latest turn, running or not, with its ID, status, and input. It comes from the turn and delivery tables, so it's the same in every step and through a compaction. Selecting `view.turn?.id` resolves once per turn, and steering doesn't change it.
- **`view.messages` is lazy.** A step without the conversation, such as a task settling between turns, skips a reaction whose `select` reads it and keeps its slot. Nothing queues the skipped commit, so a hook that reads the conversation can miss facts committed outside a turn.
- **Aggregates such as `view.calls` and `view.attachments`** are still proposals.

**No reaction reads the assembled model request:** the system prompt, instruction results, recall, and other context contributions. The request is built from reactions' slots, so reading it would make a reaction depend on itself and on the order reactions are evaluated in. Today's `ctx.messages` mixes the two, which is where the order rules in the dynamic capabilities guide come from.

A subagent's reactions see only the subagent's session, as hooks do today.

### Failures, restores, and redeploys

- **A throw withdraws the slot,** then the kind's rule applies (the last column of the entries table). A `select` that throws or returns something that isn't JSON counts as a throw. The slot keeps the error and the selection's digest, so it retries when either the selection or the revision changes.
- **Effects are at least once,** keyed by `ctx.position`.
- **What's stored is small:** the slot and a digest of the selection. Entries with code, such as tools, skills with files, connections, and provider model objects, also store the full selection, which a restore passes back to `resolve` to rebuild the code. Otherwise restores reuse slots as they are, and auth attributes in other selections are never persisted. The prototype has no cap on stored selections yet.
- **A rebuild that differs follows the kind's drift policy.** Tools and the model fail closed: the recorded tools stay offered and calls to a changed one fail, and a model that differs fails the model call rather than switch. Connections and skill files still take the rebuilt result ([`dynamic-values.md`](./dynamic-values.md#slots-restores-and-redeploys)).
- **Redeploys re-resolve only code and failures.** A data slot keeps its value until its selection changes. A code slot rebuilt in a fresh process under the new revision is current, so it doesn't resolve again. Nothing replays an event.
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

Each example shows today's code, the proposed form, and the hook it desugars to. **`defineDynamic` is a reaction in its definition's own folder,** named by its file, and it wraps exactly what the file would export statically. The "as a hook" forms show the shape, but in the prototype public hooks return only intents, and capabilities come from their folders ([`dynamic-values.md`](./dynamic-values.md#the-definition)).

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

To keep today's once-per-session behavior, select `ctx.session.auth.initiator` instead, or return `null` from `select`.

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

Proposed, selecting the turn refreshes it once per turn. `select: () => null` runs it once, as today:

```ts
// agent/tools/query.ts
export default defineDynamic({
  select: (view) => view.turn?.id ?? null,
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

Proposed, the field stays dynamic, with `select` and `resolve`. `resolve` runs once, when the first image arrives:

```ts
// agent/agent.ts
import { defineDynamic } from "eve/models";

export default defineAgent({
  model: defineDynamic({
    select: (view) => view.messages.some(hasImage),
    resolve: (image) => (image ? "google/gemini-3.5-flash" : "zai/glm-5.2"),
  }),
});
```

The field lowers to an internal reaction, because the agent's own `agent.ts` is the model's only writer:

```ts
reaction({
  kind: "model",
  select: (view) => view.messages.some(hasImage),
  resolve: (image) => (image ? "google/gemini-3.5-flash" : "zai/glm-5.2"),
});
```

- **`resolve` returns the model and its settings together:** a model, or `{ model, reasoning?, modelContextWindowTokens?, modelOptions? }`. So `modelOptions` travels with the model it's for, and the static fields beside a dynamic model stay forbidden.
- **`auto()` is a dynamic `model`,** so `defineAgent({ model: auto({ options }) })` reads as it does on `main`. It decides once per turn, and a fresh process rebuilds the model it chose without deciding again ([`dynamic-values.md`](./dynamic-values.md#auto)).
- **Select the fact, not the data.** `some(hasImage)` changes once, while `messages.length` changes at every message.

An earlier draft of this doc, and of the prototype, made `agent.ts` dynamic as a whole instead. That reversed: static fields had to sit beside `select` and `resolve`, `auto()` had to be spread in, and subagents grew a dual mode. The field keeps the property the whole file was after, one hole for one coupled decision ([`dynamic-values.md`](./dynamic-values.md#the-dynamic-model-field)).

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

The map desugars to a selection of the latest position, with the commit's facts dispatched to the handler. That's eve's own reaction: an authored `resolve` doesn't get the facts.

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

Proposed, it returns a cancel intent, and `ctx.cancel()` goes away. The intent targets the turn running when it resolves, and its reason becomes the turn's cancellation reason:

```ts
export default defineHook({
  events: {
    "turn.started": async (_fact, ctx) =>
      (await hasCredentials(ctx.session.auth.current)) ? null : cancel("Sign in first"),
  },
});
```

As a reaction:

```ts
export default defineHook({
  select: (view, ctx) =>
    view.turn?.status === "running"
      ? { turnId: view.turn.id, caller: ctx.session.auth.current?.principalId ?? null }
      : null,
  resolve: async (turn) =>
    turn && !(await hasCredentials(turn.caller)) ? cancel("Sign in first") : null,
});
```

### Channels

A channel has two sides. Its routes turn platform requests into inputs, and they stay as they are. Its outbound side becomes hooks scoped to the sessions the channel owns.

The prototype keeps today's channel signature and dispatches channel handlers after each commit, through the same dispatcher as reactions. The rest of this section is still a proposal.

Today, `events` handlers receive `(event, channel, ctx)` and keep their own state in `channel.state`:

```ts
// agent/channels/support.ts
export default defineChannel({
  routes: [
    POST("/threads/:threadId/messages", async (request, { from, params }) => {
      const { message } = await request.json();
      const session = await from(params.threadId).send(message, { auth: null });
      return Response.json({ sessionId: session.id });
    }),
  ],
  events: {
    "message.completed"(event, channel) {
      return postMessage(channel.continuation.token, event.message);
    },
    async "step.started"(_event, channel) {
      channel.state.statusId = await setStatus(channel, channel.state.statusId, "Thinking…");
    },
    async "input.requested"(_event, channel) {
      channel.state.statusId = await setStatus(channel, channel.state.statusId, "Waiting for you");
    },
    async "turn.completed"(_event, channel) {
      await setStatus(channel, channel.state.statusId, null);
    },
  },
});
```

The status line depends on listing every event that changes it, so a failed or cancelled turn leaves it stale. A retried step repeats the handlers, and channel handlers run before the event is written, so a channel can post about an event whose write then fails.

Proposed, the routes stay as they are, the event map uses v27's names with `(fact, ctx)`, and the status line is a hook that selects state:

```ts
// agent/channels/support.ts
export default defineChannel({
  routes: [/* as today */],
  events: {
    "turn.settled"(fact, ctx) {
      if (fact.data.outcome === "completed") {
        return postMessage(ctx.channel.continuation.token, replyText(fact));
      }
    },
  },
  hooks: {
    status: defineHook({
      select: (view) => activity(view), // "thinking" | "waiting" | "idle"
      resolve: async (activity, ctx) => {
        const statusId = await setStatus(ctx.channel, ctx.previous?.statusId, STATUS[activity]);
        return data({ statusId });
      },
    }),
  },
});
```

As reactions, a channel is a bundle of hooks that eve mounts only for the sessions it owns, with `ctx.channel` in their context. The `status` hook runs as written, and the event map desugars like a hook's:

```ts
defineHook({
  select: (view) => view.latest["turn.settled"] ?? null,
  resolve: (_position, ctx) => dispatch(events, ctx.facts),
});
```

- **Routes are inputs.** `send`, `respond`, `cancel`, and `compact` from `from(address)` reach the machine like any other input.
- **Handlers run after the commit,** so a channel only posts about facts that were written. That's the order the lifecycle doc asks for: write, then channel handlers, then hooks ([`session-event-lifecycle.md`](./session-event-lifecycle.md#observers-hooks-and-channels)).
- **The status follows the session.** Selecting `activity(view)` updates it once per change, whichever fact caused it. The status message's ID lives in the slot, so a restore updates the same message.
- **`channel.state` keeps per-delivery data,** such as what `deliver` merges in. Data a channel's hooks own moves into their slots.
- **The `status` hook reads `ctx.previous`,** which an authored `resolve` no longer gets ([The primitive](#the-primitive)). Channel hooks would be eve's own reactions, so they could keep it; otherwise the status message's ID stays in `channel.state`.

### Memory

The prototype runs memory on reactions but keeps the provider's event keys, `recall["turn.started"]` and `capture["turn.completed"]`. It removes `visibility` and the compaction recall and capture points. The reshape below is still a proposal.

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

None of these is possible today. They're beyond the plan, and each would land with its own doc and e2e tests. Only the compact intent in [Tools and an intent](#tools-and-an-intent) works in the prototype; public hooks there return intents, not capabilities.

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
- **Redeploys** re-run only reactions whose slots hold code or a failure. A data slot keeps its value until its selection changes, and code rebuilt in a fresh process under the new revision isn't resolved again. A code fingerprint per reaction would narrow this further.
- **Storage** is one slot per reaction, plus older slots while calls that started under them are open. Selections are stored whole only for entries with code. The standalone prototype capped them at 4 KiB, and #4616 has no cap yet. Slots ride the checkpoint and never reach the stream.

Not measured: Workflow step overhead, checkpoint serialization, real resolver I/O, and the cost of keeping views immutable in eve's fold.

## Compatibility

Every dynamic resolver changes shape, and the prototype ships it as a hard break with the v27 event break ([`session-event-lifecycle.md`](./session-event-lifecycle.md#compatibility-at-the-break)), so authors migrate once. The old shapes fail the build, with no alias. The first draft planned a codemod. The prototype migrated the repo by hand instead, and doesn't ship one, because about half the resolvers read `ctx` in ways no rewrite can move into a selection.

- **Event keys become selections.** `session.started` maps to `select: () => null`, `turn.started` to `view.turn?.id`, and `step.started` to `view.latest["model.requested"]`. Reads of `ctx.messages` move into `select` as `view.messages`.
- **`resolve` reads only its selection.** Resolvers that read or wrote `defineState` move the read into `select`, or the write into a hook's `events` handler.
- **Dynamic fields stay, as `select` and `resolve`.** `defineAgent({ model: defineDynamic({ events }) })` becomes `defineAgent({ model: defineDynamic({ select, resolve }) })`, with `defineDynamic` from `eve/models`. `model: auto(...)` is unchanged. The first draft turned dynamic fields into dynamic files, which reversed ([The model, from the conversation](#the-model-from-the-conversation)).
- **Durable callbacks go away.** `defineDurableCallback` and `defineDurableSchema` are deleted, and dynamic tools are plain `defineTool()` calls ([`dynamic-values.md`](./dynamic-values.md#why-the-ast-transforms-are-gone)).
- **Dynamic remote agents lose `auth` and `headers`.** An authenticated remote agent is static.
- **Memory providers** keep their event keys. `visibility` and the compaction recall and capture points go away.
- **Hooks:** event maps stay, with v27's names, and `select` and `resolve` are the other form. `ctx.cancel()` becomes a returned `cancel(reason?)`, and `compact({ reason? })` is the second intent.
- **Running sessions don't cross the break,** so slots can change shape there.

<details>
<summary>Migration scope</summary>

- **Extension contracts.** The prototype drops the retained epochs whose fixtures author `defineDynamic({ events })` for dynamic tools, skills, and instructions, and the affected connection and subagent epochs. Their reports aren't regenerated yet, because the contract tooling already fails on the base branch.
- **Third-party extensions and memory providers** built against the old API break until they update.
- **In this repo:** the e2e fixtures, extension packages, templates, and apps are migrated in #4616. The public docs aren't yet.

</details>

## Plan

The first draft planned three steps: a pipeline on `main` behind today's API, the same pipeline on v27 commits in the conversation slice, and the API as the last PR of the break. The prototype skipped the first two. Deleting the event-bound lifecycles outright turned out simpler than keeping them running on a new pipeline.

**Where the prototype stands ([#4616](https://github.com/vercel/eve/pull/4616)):**

- **One runner** (`reactions/runner.ts`) evaluates every reaction after each commit, in the fixed order, and restores code from recorded selections. Per-kind adapters read, validate, and apply the slots, and dispatch for out-of-turn commits goes through the same path.
- **Deleted:** the six dynamic lifecycles, the memory lifecycle, participants and change points, durable callbacks and schemas, callback rebinding, the dynamic tool and remote-agent AST transforms, synthetic resolver events, and the history-projector abstraction. Across the repo, the branch adds about 5,400 lines and removes about 16,400, tests and fixtures included.
- **Still open before it merges:** a rebase onto the merged v27 stack, the extension contract epochs and reports, the public docs, and the drift policy for connections and skills.

**Beyond the plan, not scheduled.** Each lands as a minor after the break, with its own doc and e2e tests:

- hooks returning more than effects and intents: data, capabilities, and mixed results, and intents beyond `cancel` and `compact`, such as `requireApproval`;
- more dynamic fields, starting with `available` ([`dynamic-values.md`](./dynamic-values.md#widening-later));
- dynamic extension mounts;
- timers, context edits, and request parameters;
- the channel signature and channel-scoped hooks;
- async reactions for eve's own loop.

## Open questions

**Settled in review and the prototype:**

- **Revisions per reaction** (was 1). Only slots with code or a failure re-resolve under a new revision, and code a fresh process rebuilt under it doesn't resolve again. A fingerprint per module would narrow it further, and isn't needed to ship.
- **Restores that rebuild something different** (was 4). It depends on the kind. Tools fail closed: the recorded declarations stay offered, and calls to a changed or missing tool fail. A model that differs fails the model call. Connections and skill files are still open, below.
- **Resolvers with several keys** (was 6). Migrated by hand under one selection. There's no codemod.
- **Session state read around the selection** (was 7). `resolve` runs outside the session's context, and a context read throws with a message that points at `select`.
- **Build-time fields in a dynamic `agent.ts`** (was 8). Moot: `agent.ts` isn't dynamic. The model field is, and every other field stays static.
- **Recall after compaction** (was 9). The compaction recall and capture points are gone.

**Semantics:**

1. **Drift for connections and skills.** They take the rebuilt result with a warning. Should they fail closed like tools and the model, and what would failing closed mean for a connection whose server lists different tools?
2. **Presenting a decision versus making it.** Tools can change at any model call. [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) invalidates the whole cache when tool definitions change, and [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) recommends stable tools with `allowed_tools`. Should the harness remove tools only at turn start, and mask or append them mid-turn where a provider supports it?
3. **History and time beyond the operational view.** The view prunes closed calls and turns, so a selection can't count earlier deploys, or read the turns before the latest one, and nothing in it carries a committed time for "at most every ten minutes" or timers. Should reactions declare folded aggregates that survive pruning, and should commits carry an `at`?
4. **The cap on stored selections.** The prototype has none. Small, like the standalone prototype's 4 KiB, or generous, such as 64 KiB, since it bounds stored data per reaction rather than traffic per commit?
5. **The turn's input.** `view.turn.input` counts the deliveries admitted before the turn started. Should memory recall and capture read it, instead of inferring the input from message roles as the prototype does?
6. **The warm and cold gap.** A captured value that changed under the same declaration is used in a fresh process and not in a warm one. Is a development-mode cold check, which rebuilds each code slot once and warns on a difference, worth building before the API ships ([`dynamic-values.md`](./dynamic-values.md#what-we-gave-up))?

**Scope:**

7. **The channel signature.** Should channels move to `(fact, ctx)` in v27, when their event names break anyway, or in a minor after it?
8. **Intents.** Which come after `cancel` and `compact`, with what caps per delivery, and is `cause: {reaction}` enough attribution? Each new kind also needs the fact that satisfies it.
9. **Hooks as the public reaction.** In what order do hooks gain data, capabilities, and mixed results? Once hooks can return an entry kind, it's public contract. Do capabilities a hook declares need the same e2e coverage as their own folders?
10. **Async reactions.** Does eve's loop move onto them, and when? On Workflow they need a retried step to catch up from the stream, and a cancel to reach a running step.
