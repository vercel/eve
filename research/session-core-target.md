---
issue: "None (maintainer-requested research)"
status: draft; the waiting vocabulary is implemented on stack #4696
last_updated: "2026-10-13"
---

# Session core: the target and what 1.0 locks

This doc describes where the session core should end up, and which parts of that have to be decided before 1.0. It builds on [`session-event-lifecycle.md`](./session-event-lifecycle.md), which defines the v27 facts, and [`session-changes-overview.md`](./session-changes-overview.md), which maps what landed. Code was read and prototyped on `proto/harness-core`, stacked on the reactions prototype [#4616](https://github.com/vercel/eve/pull/4616). The stack has since taken the waiting vocabulary, response rows, and the lifecycle from the public view ([What landed](#what-landed)); the single scheduler is still the target.

## Summary

- **The target is one scheduler that advances while it has work and otherwise waits for any input.** It decides from the public view and a small map of private payloads, with no pause kinds and no waiter per kind.
- **Only the stream needs deciding before 1.0.** The session program, its durable steps, and its private state can change after 1.0, because only idle sessions cross deployments, through a versioned checkpoint with upgrades. What can't change cheaply is what readers depend on: the facts, the public tables and selectors, and hook and channel keys.
- **The waiting vocabulary is the stream decision, and it landed in PR 2 (#4567).** A wait on work isn't a fact. A wait on a person is: `turn.paused` lists the interactions, and the turn's open deliveries settle `awaiting-input`. `turn.resumed` and the turn row's `paused` status are gone. The step's publisher writes these facts as the step ends, from the tables; the step only says whether it stopped for a person.
- **What 1.0 promises is the vocabulary, not a derivation.** The prototype first tried to make the wait exactly derivable from public facts. The evals showed that would put the scheduler's private distinctions on the stream, so the session decides when it has stopped, and the facts say who it waits on ([Who decides](#who-decides-that-the-session-stopped)).
- **The prototype was smaller and behaved the same in the flows tested.** Production code was down about 1,150 lines net against #4616, and the human-in-the-loop fixtures passed as before. Most of it is now on the stack ([What landed](#what-landed)).

## What 1.0 locks

| Surface                                                     | Locked after 1.0?       | Why                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Facts and their meaning**                                 | Yes, the hardest        | Clients fold them, and stored streams are read forever, including a retired session's, which its replacement names in `session.started.predecessor`                                                                                       |
| **Public tables and selectors** (`eve/events`)              | Yes                     | Hooks, channels, and clients read them through `ctx.view`                                                                                                                                                                                 |
| **Hook and channel event keys**                             | Yes                     | Authored code keys on them                                                                                                                                                                                                                |
| **Inbox commands, the child protocol, the remote protocol** | Additive changes only   | Owners on different deployments talk during skew. The remote protocol is versioned. A child reports only `parked` or `terminal` and its result, and relays travel as interactions, so none of them encodes how a turn waits               |
| **Idle checkpoint**                                         | No                      | Versioned, with an upgrade per version (`checkpoint-migrations.ts`). The stack keeps version 16 and refuses pre-v27 checkpoints, so the deployment that owns an old session finishes it                                                   |
| **Session program, durable steps, private state**           | No                      | A session moves to another deployment only while idle ([`single-workflow-session-upgrades.md`](./single-workflow-session-upgrades.md)). A mid-turn session finishes on the deployment that owns it, so its program never runs on new code |
| **Self-hosted Worlds**                                      | Not by the session core | Where a World doesn't replay each run on its own deployment, any eve version bump strands mid-turn sessions, whatever changed (#4479–#4482). A layout change adds nothing to that                                                         |

This corrects an earlier claim in the harness work that changing the durable layout after 1.0 would need migrations or versioned replay. It would only change what the idle checkpoint upgrade has to do.

## The waiting vocabulary

### Before and after

| The first v27 PRs                                                                               | The stack                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `turn.paused {awaiting: [{interactionId} \| {callId} \| {taskId}]}`, from each path that pauses | `turn.paused {awaiting: [{interactionId}]}`, only for a person, from each step's publisher |
| `turn.resumed {cause}`, from each path that leaves a pause                                      | Gone. The turn's next `model.requested` or `delivery.consumed` shows it going on           |
| `delivery.settled awaiting-input`, from the pause paths                                         | The same fact, from the same place as `turn.paused`                                        |
| Turn row status `running \| paused \| settled`, with `awaiting` and `resumedBy`                 | `running \| settled`. `waiting(view, turnId)` says what an open turn waits on              |
| `activity` kinds include `reviewing`, from `resumedBy`                                          | No `reviewing`                                                                             |
| A durable step that only published a wait on tasks                                              | Gone                                                                                       |

`turn.paused` survives because readers that follow the stream from a cursor don't fold. `ClientSession` keeps only `{sessionId, streamIndex}`, and `respond()`, `watchTurn({startIndex})`, CLI `invoke`, and the exported `endsTurn` read on from a position. Deriving the wait in the reader would make every such read fetch a view first. It would also make old clients miss any new kind of wait, where a fact keeps them correct. So the fact stays, but it means one thing, and the session writes it from the same tables readers fold.

A wait on work needs no fact, because no reader stops there: a turn waiting on a workflow run keeps the response open until the turn settles or needs someone.

### The selector

`waiting(view, turnId)` reads the public tables, in this order:

1. **The session's own work, so `undefined`:** a model run open, a context change running, an answer it hasn't weighed (unless its responder must sign in first), a delivery the turn consumed after it last requested a run or asked someone, a call running that no task serves, a requested call whose approval was accepted, or requested calls with nothing in flight.
2. **A person:** an unanswered interaction under the turn is open, unless it's about a call that already ended.
3. **Work:** running calls that tasks serve.
4. **Otherwise `undefined`.**

`waiting(view, {taskId} | {callId})` answers the same for a task or call: the person its work waits on. `idle`, `activity`, and the reader's `waiting` flag use it. It answers "what does this turn wait on?" for display. It isn't a promise that the session agrees at every line, or even at every step's end ([Who decides](#who-decides-that-the-session-stopped)).

### Who decides that the session stopped

The first version made the selector exact and announced from it alone, and the evals found its gaps one at a time ([below](#what-the-evals-found)). Most became rules the engine keeps anyway:

- **Anything that needs a person is an interaction.** Approvals, questions, sign-ins, budget prompts, and a responder's sign-in all are.
- **The session's pending model call is visible:** `model.requested` lands in the commit that makes it necessary, or the input that makes it necessary is consumed after the session's last decision.
- **Every call another run serves names its task** when it starts (`call.started {taskId}`).
- **Only a step's end counts.** Inside a step, a line can look as if nothing is left to do while the step goes on.

The last gap was different. A requested call can be one the session dispatches in its next step (`eve__task_cancel`), one parked as a wait (`eve__task_wait`), or one whose approval is deferred behind running calls. The facts don't say which, and saying so would put the scheduler's private distinctions on the stream for readers who don't need them. So a turn step says whether it stopped for a person, and the publisher writes the facts from the tables. Smaller steps, such as a relayed question or a task's message, run while the turn waits, so the tables decide for them.

What 1.0 promises:

- `turn.paused` means the turn waits on people, in the commit where the session stops for them, again when someone new is asked, and again when a delivery arrives during a step and can't go further;
- the turn's open deliveries settle `awaiting-input` in that commit;
- nothing else announces a wait or its end.

### What the evals found

The first version announced from each line, and the selector had fewer cases. The human-in-the-loop evals found each gap:

| Eval                                                   | What the selector missed                                                                              | Became                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `partial-answer-keeps-turn-held`                       | One answer of a batch joins a turn that already waits on a person, and can go no further              | Announce when a delivery joins               |
| `newer-attempt-supersedes`                             | An approval's answer settles while an older sign-in is open; the cleared call is the session's to run | Approved calls are work                      |
| `budget-question-holds-the-turn`                       | The budget question comes before the run is requested, so the turn's input looked unread              | Asking someone is a decision                 |
| `relayed-question-answered`                            | A child's relayed question is about a running call, which stays in flight                             | Only a requested call waits on approval      |
| `responder-authorization-then-settles`                 | A submitted answer waits on its responder's sign-in                                                   | Signing in is a person's wait                |
| `newer-attempt-supersedes`, again                      | A line inside the step looked quiescent before the cleared call asked for a newer sign-in             | Only a step's end counts                     |
| `message-waits-behind-budget`, `no-step-behind-budget` | A message queued behind the budget question, unconsumed, announced nothing                            | Announce when a delivery arrives             |
| `sign-off-plan.cancel`                                 | A requested `eve__task_cancel` is the session's to dispatch, but looks like a parked wait             | The step decides                             |
| `sign-off-plan.cancel`, again                          | A step that only found the old wait announced it again                                                | Announce only what a step changed            |
| `sign-off-plan.cancel`, again                          | A cancelled stretch's question stays open until its run withdraws it                                  | A question about an ended call holds nothing |

A shadow check in the prototype logged every turn step whose decision disagreed with the selector. In the human-in-the-loop fixtures, the disagreements left were steps that pause with a call only requested, which the session body dispatches in the next durable step.

## The target

Nothing in this section is built beyond the selector and the one publisher that announces waits.

```text
loop:
  if the session ended: finalize
  else if runnable(view, payloads):     // the open turn, or a queued delivery that starts one
    advance(inputs)     // one durable step: bounded model calls, inline calls, answers,
                        // dispatch, and the announcement at its end
  else:
    wait for anything that could change runnable: an inbox delivery, a run's message, a timer
```

- **`runnable`** reads the public view and the private payloads: calls to dispatch, deferred approvals, task waits, answers to weigh. It's the scheduler's, so it can change after 1.0.
- **Durable state:** the history, the public view, the counters, and a small map of private payloads: approval and runtime-call payloads, responder records, sign-in secrets, relay routes, grants, and reaction slots. No private record holds a status.
- **One commit path:** every step publishes through one publisher, which folds the view and announces waits. The stack already routes every publication through it (`announceWaiting` in `harness/session-machine/waiting.ts`).
- **What goes:** the turn loop's pause kinds (person, tasks, calls) and their waiters, `DurableStepResult`'s actions, the steps that only publish, and the split between a turn step and the dispatch step that follows it.
- **What stays separate:** handoff, finalization and the caller's notification, and the mid-generation steering abort, which can't wait for a step boundary.
- **The machine cuts already on the stack** fit underneath: one executor for every call (#4549) and one record of running work (#4588). None of them changes a fact.

**Batching.** `experimental.workflow.modelCallsPerStep` becomes the bound on one `advance`. It's experimental, so 1.0 doesn't lock it. Durable cost per turn is measured in [`turn-performance.md`](./turn-performance.md); fewer, larger steps should help, but nothing here is measured.

## What landed

`proto/harness-core` prototyped six changes on #4616. On the stack:

| Prototype commit                         | On the stack?                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Rules that park once                     | Yes: no stored approved-call list; approved calls run once their batch settles            |
| Response rows, not candidates            | Yes, PR 5 (#4602)                                                                         |
| Each model response to history at once   | No: suspended steps remain                                                                |
| The lifecycle from the public view alone | Yes, PR 4 (#4591)                                                                         |
| Idle sessions across the change          | Not needed: the stack keeps checkpoint version 16, and v27 refuses pre-v27 checkpoints    |
| Derived waiting, announced once per step | Yes, PR 2 (#4567): `turn.resumed`, waits on work as facts, and the paused status are gone |

One executor for every call (#4549) and one record of running work (#4588) also landed. The
prototype's shadow check, which logged every turn step whose decision disagreed with the
selector, didn't. The scheduler itself isn't built, and the durable cost per turn isn't
measured.

## After 1.0

Each of these changes only private state or the program, so it can land in a minor, with an idle checkpoint upgrade where it touches state:

- the single scheduler, and deleting the pause kinds and waiters;
- one protocol for owner messages and relays, under the remote protocol's versioning;
- a session log from which state is derived ([Toward a session log](./session-event-lifecycle.md#toward-a-session-log));
- batching and step sizes.

## Open questions

1. **Should the selector's agreement be checked?** The prototype's shadow check could come back as a dev-only log, so a path that hides its work shows up.
2. **Forwarded approvals.** One forwarded to a child stays open until the child settles it. The selector treats an answered interaction as not waiting, which covers it, but `activity` has no "waiting on a child" kind.
3. **Is `turn.paused` the right name** for a fact that now means only "waits on a person"?
