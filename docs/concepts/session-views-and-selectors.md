---
title: "Session Views & Selectors"
description: "Query session state with the same selectors in evals, hooks, channels, dynamic capabilities, and clients."
---

Whenever you have a `SessionView` and want to know what is happening in a session, start with selectors from `eve/events`. Use them to inspect calls, replies, tasks, pending requests, usage, and failures instead of reconstructing session state from events or keeping a parallel copy.

Selectors are not frontend-specific. The same functions work in evals, hooks, channel handlers, dynamic capabilities, frontend bindings, and custom stream readers.

## Read a view

A `SessionView` is an opaque, immutable snapshot derived from session events. Selectors return immutable observations, run synchronously, and perform no I/O:

```ts
import { activeTurn, calls, openInteractions, usage, type SessionView } from "eve/events";

function inspectSession(view: SessionView) {
  const current = activeTurn(view);
  return {
    current,
    currentTools:
      current === undefined ? [] : calls(view, { kind: "tool", turnId: current.turnId }),
    requests: openInteractions(view),
    usage: usage(view),
  };
}
```

The explicit check for `current` matters: an omitted or `undefined` filter means no restriction. Passing `{ turnId: current?.turnId }` would select calls across the view when no turn is open.

## Where to get a view

| Surface                                                                        | View                                                  | When it reflects the session                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------- |
| [Evals](../evals/cases#the-drive-api)                                          | `session.view`                                        | History and events recorded by that session handle so far             |
| [Completed eval turns](../evals/cases#the-drive-api)                           | `turn.view`                                           | Fixed session snapshot captured when the eval driver returns the turn |
| [In-flight eval turns](../evals/cases#in-flight-turns)                         | `live.view`                                           | Initial session snapshot plus events the live reader has observed     |
| [Hooks](../guides/hooks#hook-structure-and-context)                            | `ctx.view`                                            | The whole recorded line containing the handler's event                |
| [Channel event and commit handlers](../channels/custom)                        | `ctx.view`                                            | The whole recorded line being handled                                 |
| [Dynamic capabilities](../guides/dynamic-capabilities#context-and-memoization) | `ctx.view`                                            | The session snapshot supplied when eve computes the definition        |
| [Frontend bindings](../guides/frontend#derive-your-own-state)                  | `agent.view` in React and Svelte; `view.value` in Vue | The binding's observed session state                                  |
| [Custom readers](#fold-a-stream-yourself)                                      | A view built with `foldEvents`                        | The events you have supplied to the fold                              |

These are view-producing surfaces, not a promise that every `ctx` has a view. An ordinary tool's `execute` context does not expose `ctx.view`.

A saved snapshot never changes. Read `session.view`, `live.view`, or the binding's current view again after its reader advances. Selectors themselves do not start a reader, fetch history, or wait for work to finish.

## Pick a selector

Ask a question about the session, then select the relevant observations:

| Question                                    | Selector                                                                       | Result                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Is a turn open?                             | `activeTurn(view)`                                                             | The running or paused turn, or `undefined`                                 |
| What is happening now?                      | `activity(view, { turnId? })`                                                  | A summary such as thinking, calling, or waiting                            |
| What holds a turn open?                     | `waiting(view, turnId)`                                                        | Session work, interactions, calls/tasks, or `undefined`                    |
| Which calls ran?                            | `calls(view, { kind?, name?, turnId?, runId?, taskId? })`                      | Calls with resolved ownership, input, output, state, and timing            |
| What happened to one call?                  | `call(view, callId)` / `callState(view, callId)`                               | Its observation or display state, or `undefined`                           |
| What still needs a response?                | `openInteractions(view, { kind?, about? })`                                    | Open approvals, questions, and sign-ins, oldest first                      |
| Did a person approve?                       | `interaction(view, interactionId)`                                             | Request, answer, status, and outcome when known                            |
| What did a turn reply?                      | `reply(view, turnId)`                                                          | Reply content parts in order, not joined text                              |
| What did the model produce?                 | `parts(view, { runId?, turnId?, kind? })` / `part(view, partId)`               | Content observations with kind, phase, value, and references               |
| What turns are retained?                    | `turns(view)` / `turn(view, turnId)`                                           | Turn status, outcome, error, and timing                                    |
| Which turns form the selected conversation? | `conversation(view)`                                                           | Retained turns in the selected conversation chain; empty after clear       |
| What input arrived or remains queued?       | `deliveries(view, { turnId? })` / `delivery(view, deliveryId)` / `queue(view)` | Delivery observations; the queue contains admitted, unconsumed input       |
| What tasks and model runs exist?            | `tasks(view, { status? })` / `task(view, taskId)` / `runs(view, { turnId? })`  | Execution observations and their outcomes                                  |
| Which child sessions were opened?           | `children(view)`                                                               | Child session links, not their event histories                             |
| What usage was recorded?                    | `usage(view)`                                                                  | Session totals and totals by kind; inspect `runs` for per-turn model usage |
| Why did a turn fail?                        | `failure(view, turnId)`                                                        | Turn failure, falling back to session failure, or `undefined`              |
| Has the session ended?                      | `session(view)`                                                                | Session status, outcome, error, identity, and timing                       |
| Is there work the session can do now?       | `idle(view)`                                                                   | Whether the session is idle; a turn waiting only on a person can be idle   |
| Where does this snapshot resume?            | `position(view)`                                                               | The next durable line position, not an event count                         |

ID lookups can return `undefined` when the entity is not in the view. Collection selectors return arrays; an empty result describes this snapshot, not necessarily the session's entire history.

### Calls and content

Call filters combine: `{ kind: "tool", name: "search", turnId }` requires all three to match. Filter returned observations by `state` or `outcome` when you need only completed or failed calls. Task filters accept `"working"`, `"idle"`, or `"ended"`; these describe work served by the task, not just its stored running/ended status.

`callState(view, callId)` distinguishes `approval` and `blocked` from running work. `call(view, callId)?.output` follows shared output ownership. Use `callOutputSource(view, callId)` when you need the producing call itself. `callLabel(observation)` reads a call's display label. Calls include `turnId`, `runId`, and `taskId` when known, so you do not need to join calls to model runs to find their turn.

`reply` selects the turn's answer, not narration or reasoning. Use `parts` for other content, such as `parts(view, { kind: "reasoning" })` for reasoning blocks. Values can be referenced rather than inline; selectors do not fetch referenced payloads.

### Waiting and interactions

| `waiting(view, turnId)` returns       | Meaning                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `{ on: "session" }`                   | The session can make progress by itself                 |
| `{ on: "interaction", interactions }` | Answers are needed                                      |
| `{ on: "work", calls, tasks }`        | Calls or tasks hold the turn                            |
| `undefined`                           | The turn is absent or settled, or the session has ended |

An idle session can still have an open turn waiting on a person. Use `activeTurn` to ask whether a turn is open, not `idle` alone.

`openInteractions(view, { about })` filters by what holds the work:

| `about`          | Includes                                                                             |
| ---------------- | ------------------------------------------------------------------------------------ |
| `{ callId }`     | The call's approval, questions relayed through it, and requests from its task        |
| `{ taskId }`     | That task's requests                                                                 |
| `{ turnId }`     | The turn's requests, including inline calls and responses, but not independent tasks |
| `{ responseId }` | That response's requests                                                             |

An open interaction can already have an `answer` while a response policy still weighs it. To display unanswered approvals and questions, exclude sign-ins and observations whose `answer` is defined. `interactions(view)` also includes retained settled interactions; inspect `outcome` to distinguish approval from withdrawal or interruption. `signInEnding(outcome)` gives a display description of a sign-in's ending. Interaction observations omit private sign-in callback URLs.

## Use selectors in evals

Prefer a scoped assertion such as `turn.calledTool(...)` when it already expresses your check. For custom state checks, select observations from a view and grade them with `t.check`, `t.require`, or `t.score`. The selectors are the same ones used by hooks and clients; no eval-specific state reconstruction is needed.

For example, inspect recorded task outcomes, or check exactly which requests remain open. See [Assert on session state with selectors](../evals/assertions#assert-on-session-state-with-selectors) for examples.

`turn.view` is a session snapshot at that eval boundary, not a view filtered to that turn. Collection queries can include earlier turns. Use explicit IDs and supported filters when your check is turn-specific. `activeTurn` finds an open turn, not a completed one; use an ID observed in the events or a retained turn observation to inspect a completed turn.

Run-level assertions on `t` can cover multiple sessions. A `SessionView` covers one session, so inspect each session's view separately for custom cross-session checks.

## Scope and completeness

A selector can answer only from information available in its snapshot:

- A custom fold or eval attached at a later `startIndex` can miss events that opened a call or interaction. An empty result does not prove it never existed. Read from line `0` when a complete recorded prefix is required and available.
- Runtime snapshots supplied to hooks, channels, and dynamic capabilities retain operational state, not an unbounded archive. Older closed rows can be dropped, and large call payloads can be withheld or represented by references. Complete client/history folds retain the events supplied to them.
- Child sessions have their own streams and views. `children(view)` discovers links; it does not fold child history into the parent.
- `usage(view)` is session-wide. `failure(view)` without a turn ID checks session failure, not every failed turn.

Do not use an operational snapshot as proof of a lifetime historical total. Keep domain state or an event archive when that is what the application needs.

## Progress previews

`callPreview(view, callId)` and `contentPreviews(view, { runId? })` expose transient progress held by a client or custom fold. Preview output is not a completed call result, and progress can be missing. Hook and channel snapshots describe recorded state rather than accumulating client previews.

## Fold a stream yourself

When your integration receives events but no view, use the same fold as eve's readers:

```ts
import { emptySessionView, foldEvents, calls } from "eve/events";

let view = emptySessionView();
for await (const event of session.stream()) {
  view = foldEvents(view, [event]);
  console.log(calls(view, { kind: "tool" }));
}
```

`foldEvents` returns a new snapshot, holds incomplete lines until their final event arrives, and absorbs overlapping replay. A view is not a serialization format: persist events and session cursors to reconstruct it. See [Streaming](../guides/client/streaming) for bounded reads and complete event snapshots.

## When to read events instead

Use events for exact occurrence and ordering, individual progress deltas, or event payloads a selector does not expose. For example, checking that a content delta arrived before its matching completion requires events, not just the completed content part. In evals, use event assertions when the event itself is the contract under test.

Events tell you what changed. Selectors answer where things stand. Use both in a handler: react to a `call.settled` event, then read `call(ctx.view, event.data.callId)` for the call's current observation rather than maintaining your own call table.

## What to read next

- [Assertions](../evals/assertions): grade selected facts in evals
- [Hooks](../guides/hooks): inspect the session when an event is recorded
- [Dynamic capabilities](../guides/dynamic-capabilities): compute definitions from session state
- [Sessions, runs & streaming](./sessions-runs-and-streaming): the event protocol, positions, and reconnecting
