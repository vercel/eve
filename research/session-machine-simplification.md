---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-08"
---

# Session machine simplification

Read on `main` at `285d4e09b` and the open HumanInput stack (#4342–#4344). Line counts are production code, without tests. The savings are estimates from reading code; nothing was prototyped.

## Summary

The core of a session is simple. A session is a loop of turns. A turn is a sequence of model calls and the calls they make, and some of those calls wait for a person or for another run. The code that runs it is about 30,000 lines, because that core is implemented several times over:

- each kind of wait has its own record, step result, waiter, and resume path;
- each kind of work implements each lifecycle operation separately;
- model history, private records, and the context container are kept consistent with the stream by hand;
- 63 durable steps each repeat the same ceremony;
- eve intercepts the AI SDK's inner loop instead of owning it.

This doc proposes cuts that remove about 7,000–10,000 of those lines, a quarter to a third. They overlap, so the savings don't simply add up.

Most of the cuts fold into the plan for [`session-event-lifecycle.md`](./session-event-lifecycle.md#phases):

- **On `main`, before the break,** where today's tests still cover them: turn identity, one registry for running work, and one suspension record.
- **Inside the break:** one commit path lands with the new envelope, lifecycle only in the projection with the interactions, and the compatibility deletions at the end.
- **In parallel:** a prototype of one executor for every call, which lands before the break only if it comes out clean. A longer-run direction, a session log from which all state is derived, is sketched at the end ([Toward a session log](#toward-a-session-log)).

## Where the lines go

About 30,000 lines, most of them in the step pipeline, delegated work, and execution glue.

<details>
<summary>Lines by area</summary>

| Area                                                                                     | Where                                                                                      | Lines |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----- |
| Session workflow program: the session loop, the turn loop, the turn step, waits, handoff | `execution/session/`                                                                       | 4,600 |
| Session machine                                                                          | `harness/session-machine/`                                                                 | 1,200 |
| Step pipeline, tool loop, SDK interception, emission                                     | `harness/` top level, `harness/step/`                                                      | 9,000 |
| Human input: approvals, sign-ins, questions, relays, budget                              | `harness/hitl/`; about 6,800 after HumanInput                                              | 3,350 |
| Delegated work: tasks, workflow tools, agent sessions, subagents                         | `execution/tasks/`, `execution/tools/workflow/`, `execution/agent-sessions/`, `subagents/` | 7,900 |
| Inbox and other execution glue                                                           | `execution/session-inbox/`, `execution/` top level                                         | 5,600 |
| Legacy compatibility                                                                     | `execution/legacy-session/`, `execution/legacy-remote-agent/`                              | 810   |

</details>

Outside that total are model-call plumbing (2,300), compaction (1,100), sandboxes (9,000), and other tool implementations.

## Why it's large

### Every wait is a suspension, in about seven shapes

A durable step can't stay open while a person or a run works. So each kind of wait needs all of these:

- **A private record.** After HumanInput, these are `TurnState` (suspended steps with their approvals and runtime work, relayed routes, the session-limit request), the sign-in challenges (`eve.runtime.pendingAuthorization`), the workflow tool run registry, and the task table.
- **A step-result variant.** `DurableStepResult` has `continue` or `done`, `cancelled`, `steered`, `held` on tasks, `held` on a request, and `park` with pending calls.
- **A workflow-side waiter:** `waitForHeldRequest`, `waitForHeldTurn`, `waitForRuntimeActionResults`, `nextParkedActivity`.
- **A resume stage** at the start of the next step, such as settling runtime work or accepting human input.
- **Facts** in the projection.

<details>
<summary>One wait end to end: a sign-in</summary>

A tool that needs a sign-in touches every piece, across six files. The excerpts are trimmed, and HumanInput keeps the same shape.

**History.** The step drops the interrupted calls, so the model never sees a call without its result. The interrupt itself comes from the out-of-band stash (`harness/inline-tool-authorization.ts`):

```ts
return {
  callIdsByName,
  challenges: resolveActiveAuthorizationChallenges(signals.flatMap((signal) => signal.challenges)),
  history: withoutCalls(input.messages, interruptedCallIds),
};
```

**Record.** The machine's commit stores the challenges under their own key (`harness/session-machine/commit.ts`):

```ts
transition.signIns.length === 0
  ? clearPendingAuthorization(session.state)
  : setPendingAuthorization(clearPendingAuthorization(session.state), {
      challenges: transition.signIns,
    });
```

**Step result.** The turn step reports the hold as its own variant (`execution/session/turn-step-types.ts`):

```ts
| {
    readonly action: "held";
    readonly hold: "request";
    readonly authorizationAttemptIds: readonly string[];
    readonly hasPendingInputBatch: boolean;
    readonly inputRequestIds: readonly string[];
  }
```

**Waiter.** The turn loop branches on that variant to a waiter of its own (`execution/session/turn.ts`). `takeAuthorizations` returns nothing until every attempt has called back:

```ts
if (result.action === "held" && result.hold === "request") {
  const woke = await this.waitForHeldRequest(turn, result);
  if (woke === "cancelled") return await this.finishCancelledTurn(turn);
  nextStepInput = { delivery: woke };
  continue;
}

private async waitForHeldRequest(turn, held) {
  const attemptIds = new Set(held.authorizationAttemptIds);
  const requestIds = new Set(held.inputRequestIds);
  while (true) {
    const callbacks = this.input.queue.takeAuthorizations(attemptIds);
    if (callbacks !== undefined) return { kind: "deliver", payloads: callbacks };
    const answer = await turn.takeInputResponses(requestIds);
    if (answer !== undefined) return answer;
    const steering = await turn.takeSteering({ heldOnPerson: true });
    if (steering !== undefined) return steering;
    const next = await turn.nextRuntimeEvent([]);
    if (next === "cancelled") return next;
    if (next.kind === "workflow") await this.handleWorkflowMessage(next.message);
  }
}
```

**Resume stage.** Before anything else, the next turn step matches the callbacks against the record, hands their results to the tool through the context container, and clears the record (`execution/session/turn-step.ts`):

```ts
const pendingAuth = getPendingAuthorization(durableSession.state);
if (pendingAuth && delivery !== undefined) {
  const { matches, remainingPayloads } = matchAuthorizationCallbacks(
    pendingAuth,
    delivery.payloads,
  );
  delivery = { ...delivery, payloads: remainingPayloads };
  if (matches.length > 0) {
    const matchedAttemptIds = matches.map((match) => match.result.attemptId);
    ctx.set(
      PendingAuthorizationResultKey,
      matches.map((match) => match.result),
    );
    durableSession = {
      ...durableSession,
      state: clearPendingAuthorization(durableSession.state, matchedAttemptIds),
    };
  }
}
```

**Facts.** Separately, the projection folds `authorization.required` and `authorization.completed` into its own table, keyed by attempt (`protocol/session-projection.ts`):

```ts
case "authorization.required": {
  const attemptId = typed.data.attemptId ?? typed.data.name;
  // … status: "required"
}
case "authorization.completed": {
  // … status: typed.data.outcome
}
```

Approvals share this step result and waiter. Waits on tasks and on runtime work have their own record, step result, waiter, and resume stage.

</details>

### Kinds of work times lifecycle operations

**Kinds of work:**

- inline tools that the SDK runs;
- approved inline calls that eve runs itself;
- provider tools and MCP tools;
- workflow `execute`, `task()`, and `serve()`;
- local and remote agent sessions;
- nested connection calls.

**Lifecycle operations:** start, progress, ask, sign in, approve, return, cancel or interrupt, and crash.

Each pair is implemented per kind:

- **Two executors for inline calls.** The SDK runs most of them through the wrappers in `harness/tools.ts` and the stash in `tool-interrupts.ts`. `harness/hitl/approved-calls.ts` (340 lines) reimplements validation, `Promise.allSettled`, partial outputs, and `toModelOutput` for approved ones.
- **25 cancel functions in 17 files.** One turn's cancel shows why: `cancelTurnWork()` fans out to a different mechanism for each kind of work.
- **Two registries for running work:** blocking workflow tool runs (`harness/workflow-tool-runs.ts`) and the task table (`execution/tasks/table.ts`). Both store a run ID and a hook token.
- **Three message vocabularies, in five encodings,** for about six ideas: started, asks a person, needs a sign-in, answer or withdraw, result and usage, and stop.

<details>
<summary>Stopping one turn's work</summary>

| Stops                       | Through                                                 | How                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Blocking `execute` runs     | `cancelDescendantTurnsStep` → `cancelWorkflowToolRun`   | `cancel` on the run's control hook; then polls the run's status every 250 ms for up to 35 seconds; then `cancelRun`                                                                                                |
| Tasks                       | `cancelWorkingTasks` → `cancelTasksStep` → `cancelTask` | A table transition, with branches for resumable tasks and for runs that haven't started, which hold the cancel. Then `cancel` on the control hook, withdrawals for what a `task()` run relayed, and `task.settled` |
| Agent sessions a run opened | `cancelAgentSessionTurnStep`, fire and forget on abort  | Remote: an HTTP POST to `cancel-turn`, with its own response schema. Local: a `cancel` session command                                                                                                             |
| Runs, when steering arrives | `interruptWorkflowToolRun`                              | `interrupt` on the control hook, if it still exists                                                                                                                                                                |
| Every task, at session end  | `terminateChildSessionsStep`                            | `end` instead of `cancel`, through the same signal, poll, and force path as blocking runs                                                                                                                          |

The same run stops differently depending on who stops it. A task cancelled with its turn gets a hook message and is trusted to end itself; at session end, the same task is forced after 35 seconds.

```ts
// execution/session/turn.ts
async cancelTurnWork(): Promise<void> {
  const { cursor } = this.input;
  if (mayWaitOnWorkflowToolRuns(cursor.sessionState)) {
    await cancelDescendantTurnsStep({ serializedContext: cursor.serializedContext, sessionState: cursor.sessionState });
  }
  await cancelWorkingTasks(cursor, "turn_cancelled");
}

// execution/tools/workflow/cancel.ts
try {
  await resumeHook(run.hookToken, stop);
  signalled = true;
} catch (error) {
  // A fresh run may not have registered its control hook yet.
}
await settleWorkflowToolRunCancellation(run.runId, reason, signalled); // poll, then cancelRun

// execution/tasks/table.ts
if (record.resumable) return cancelResumableTask(table, record);
// …
if (run === undefined || !run.started) return { settled, table: next }; // the cancel is held
return { send: cancelCommand(run), settled, table: next };

// execution/agent-sessions/steps.ts
if (address.kind === "remote") {
  await cancelRemoteAgentTurn({ remote, sessionId: address.sessionId }); // HTTP
  return;
}
await requestWorkflowTurnCancellation({ sessionId: address.sessionId }); // session inbox
```

</details>

<details>
<summary>The vocabularies and their encodings</summary>

| Encoding                                                        | Between                                                                 | Messages                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow run messages (`execution/tools/workflow/messages.ts`)  | A session and the runs it starts for `execute`, `task()`, and `serve()` | Run to session: `started`, `agent-started`, `request` (an `ask`, an `input-batch` from a child, or an `authorization-request`), `withdraw`, `report`, `reply`, `usage`, `outcome`. Session to run, on the run's control hook: `call`, `cancel`, `end`, `interrupt`, `answer`, `withdrawn` |
| Child hook payloads (`HookPayload` in `channel/types.ts`)       | A local child session and its parent                                    | `subagent-input-request`; `subagent-authorization-event`, which nests v26 approval and sign-in events; `runtime-action-result`                                                                                                                                                            |
| Remote callbacks (`subagents/callback-route.ts`)                | A remote child session and its parent                                   | The same payloads as HTTP POSTs, validated with strict schemas. Results arrive as `turn.completed` or `turn.failed`. Answers go back through `forward-session-input.ts`                                                                                                                   |
| Session inbox (`SessionCommand` and the delivery hook payloads) | Anyone and a session                                                    | `send`, `deliver`, `cancel`, `clear`, `compact`, `reset`, `session-timeout`. Remotely, the agent API's send, cancel-turn, and reset endpoints; remote agent protocol 1 is the legacy version                                                                                              |
| Parent notifications (`subagents/parent-notification.ts`)       | A child session's turn and its caller                                   | A settled turn as a `subagent-result` with a lifecycle verdict, by `resumeHook` locally or a callback POST remotely, plus a separate variant for a cancelled caller                                                                                                                       |

A question from a session that a run opened changes vocabulary at each hop. The child sends `subagent-input-request`, the run forwards it as `request {input-batch}`, and the owner publishes it as `input.requested`.

</details>

### State kept consistent by hand

The projection is a fold of the stream, so the two can't disagree. But each transition also updates three other kinds of state, and nothing checks that they agree with the stream:

1. **Model history.** The AI SDK's pairing rules mean an interrupted call has to leave history or get a result, so repair helpers run wherever calls stop.
2. **Private records,** listed above.
3. **The serialized context container,** which carries values between steps, such as the turn's delivery IDs and dynamic resolver results.

The sign-in above touches all three, and the stream. When they drift, the projection says one thing and execution does another. One bug caught while building the session-state stack: withdrawing a sign-in left its challenge in the record after the projection had closed it.

Turn identity shows the same problem in a single value. Three places compute it from the projection's sequence, as `` `turn_${n}` ``: `protocol/session-projection.ts`, `harness/session-machine/view.ts`, and `execution/workflow-trace-context.ts`. But `execution/session/program.ts` keeps its own counter, which restarts in every owner run, so after a handoff a failure is attributed to the wrong turn.

### 63 durable steps, each with its own ceremony

There are 66 step functions in 37 files, 3 of them legacy. Each repeats restore, publish, and save; there are 54 sites of `cursor.advance`, `withSessionStateDelta`, and `restoreSessionStep`.

Eleven small steps exist mostly to publish a few events from workflow code, among them:

- turn waiting;
- settling a cancelled turn;
- terminal completion and failure;
- withdrawing a request;
- coordination dispatch;
- task steps;
- workflow tool reports;
- proxied deliveries.

### The AI SDK owns the inner loop, so eve intercepts it

eve:

- wraps every tool;
- stashes interrupts out of band, because the SDK records tool outputs into telemetry;
- extracts approvals from response parts;
- mirrors the SDK's stream into events;
- repairs history after interrupts.

This cluster overlaps the areas above.

## The cuts

| Cut                                                                                       | Saves       | For the event lifecycle                                      |
| ----------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------ |
| [Turn identity from the projection](#turn-identity-from-the-projection)                   | A bug fix   | Lands first; retry recovery relies on deterministic turn IDs |
| [One commit path](#one-commit-path)                                                       | 800–1,200   | Lands with the new envelope                                  |
| [Lifecycle only in the projection](#lifecycle-only-in-the-projection)                     | 500–1,000   | Lands with the interactions                                  |
| [One suspension record](#one-suspension-record)                                           | 1,000–1,500 | Before the break; makes `turn.paused.awaiting` a direct read |
| [One registry and protocol for running work](#one-registry-and-protocol-for-running-work) | 1,500–2,500 | Registry before the break; protocol with the relay contract  |
| [One executor for every call](#one-executor-for-every-call)                               | 1,500–2,500 | Prototyped in parallel; makes call outcomes exact            |
| [Delete compatibility at the break](#delete-compatibility-at-the-break)                   | About 1,500 | At the break                                                 |

### Turn identity from the projection

**Problem.** `execution/session/program.ts` keeps `turnIndex` locally and sets `progress.turnId = `turn_${turnIndex++}``. The counter restarts in each owner run. The failure path passes that ID to `finalizeSession`, while the completion path uses `lastPublishedTurn`, so after a handoff a failing session names the wrong turn.

**Cut.** Read the turn from the projection everywhere (`turnPosition`, `activeTurnId`), and delete the local counter and `lastPublishedTurn`.

**Notes.** It's small, and can land now. `program.ts` is in HumanInput's diff, so it's worth coordinating with that stack's authors on whether to land it before or after.

### One commit path

**Problem.** The eleven small publishing steps each restore the session, publish one or two events through their own path, and save a delta. `harness/session-machine/commit.ts` applies a transition by publishing its events one at a time, so a "commit" has no boundary that the stream can see.

**Cut.** Every step that changes the session applies its inputs through one machine commit: restore, transition, publish the commit, save. HumanInput already has the seed of this: `commitSessionStep(target, inputs)` in `execution/session/human-input-step.ts`, used by the task steps and the workflow tool withdraw step. That becomes the session's commit path, not a HumanInput helper, and keeps today's effect order.

**For the event lifecycle.** "One transition, one commit, one stream line" becomes true everywhere at once, instead of only in the turn step.

### Lifecycle only in the projection

**Problem.** Some lifecycle status lives in two places: in the projection, and in private records such as human input's request and batch state. Two authorities can disagree, and readers outside `hitl/` are tempted to read the private one. HumanInput also builds turn and message events itself (`turn.waiting` and `message.completed`, among its 26 v26 event builder calls).

**Why the records are still there.** The session-state work (#4177) moved the status of sign-ins and relayed requests into the projection, and HumanInput moves relayed routes into `TurnState`. The records stayed for two reasons:

- **They hold data that can't go on the stream:** a sign-in's callback URL, principal, requester, and resume value; a relayed request's continuation token, inbox, and remote binding.
- **v26 lacks the facts that would make the projection the only authority.** `attemptId` is optional, so the projection falls back to the connection name, and nothing reports a call that a sign-in stopped. The session-state stack stayed on v26 and deferred both. In v27, every sign-in attempt is an interaction with its own ID, and a stopped call settles `interrupted`.

**Cut.**

- The projection is the only lifecycle authority.
- Private records hold payloads, routes, grants, and resume data, never status.
- `hitl/` emits only interaction, response, and call facts: approvals' `call.started` and rejections' `call.settled`. The machine owns turn and delivery facts.
- Sign-in callbacks arrive as deliveries ([`session-event-lifecycle.md`](./session-event-lifecycle.md#payloads-by-family)), so their separate inbox kind and the queue that holds them (`takeAuthorizations`) go away.

**For the event lifecycle.** Required before interactions move to the new events. Otherwise two producers write turn facts.

### One suspension record

**Problem.** The seven wait shapes above.

**Cut.**

- `turn.paused {awaiting}` becomes the only record of what a turn waits on.
- One waiter wakes on any input that references an awaited entity.
- One intake applies inputs as transitions.
- A step returns one of four results: continue, paused, settled, or cancelled.

**For the event lifecycle.** Optional. It makes `turn.paused.awaiting` a direct read instead of a translation.

### One registry and protocol for running work

**Problem.** Two registries, about 25 cancel functions, and three message vocabularies in five encodings.

**Cut:**

- **One registry:** workflow tools, tasks, and local and remote agents register in one table of running work, keyed by `callId`, with one cancel path.
- **One protocol:** they speak the same owner messages. Relays become one request-and-answer routing table.

**Notes.**

- HumanInput already folds the human-input relay paths into `harness/hitl/relay.ts`, deleting `subagents/hitl-proxy.ts` and `harness/proxy-input-requests.ts`. What remains is the registry and the other messages.
- The relay contract between parent and child sessions, keyed by child IDs, parsed tolerantly, and under a new remote protocol version, lands with the event break, because it replaces v26 event payloads ([Child sessions and relays](./session-event-lifecycle.md#child-sessions-and-relays)).

### One executor for every call

**Problem.** The SDK runs most inline calls while eve runs approved ones, and eve intercepts the SDK to stash interrupts, extract approvals, and repair history.

**Cut.** The SDK only calls the model: tools are given to it without `execute`, and eve runs every call. Approval, sign-in, steering aborts, and approved execution become one path. That removes:

- the interception layer;
- the duplicate executor;
- most history repair.

**For the event lifecycle.** Optional. It makes "calls settle by what actually happened" exact rather than best-effort. It's also the natural place for a private journal of run and tool results, so a retried step can reuse them.

**Risks.** It changes how eve uses the AI SDK's multi-step loop, provider-executed tools, streaming tool input, and `toModelOutput`. Prototype it first.

### Delete compatibility at the break

Sessions don't cross the event break, so the break can delete:

- the one-time legacy session import (`execution/legacy-session/`, 638 lines). That's a product decision;
- remote agent protocol 1 (`execution/legacy-remote-agent/`, 172 lines);
- most checkpoint migrations (`execution/session/checkpoint-migrations.ts`, 330 lines), once `MIN_SESSION_CHECKPOINT_VERSION` moves to the break;
- HumanInput's legacy parking keys (`harness/hitl/state-legacy.ts`).

The first two are also counted in [`session-event-lifecycle.md`](./session-event-lifecycle.md#size).

## Sequencing

[`session-event-lifecycle.md`](./session-event-lifecycle.md#phases) lists the PRs. For these cuts:

1. **On `main`, now:** turn identity from the projection, and one registry for running work. The registry overlaps HumanInput (#4342–#4344) in the task steps and relays, so whichever lands second rebases.
2. **On `main`, stacked on HumanInput** rather than waiting for it: one suspension record.
3. **With the new envelope:** one commit path, as the publisher becomes the session's only way to write.
4. **With the interactions:** lifecycle only in the projection, and the relay contract with one protocol for owner messages and relays.
5. **At the end of the break:** the compatibility deletions.
6. **In parallel:** the executor prototype. It lands on `main` before the conversation slice if it's clean, and otherwise after the break, since it changes only the producer.

What these cuts need from HumanInput:

- `commitSessionStep` becomes the session's commit path;
- no new readers of its private request state outside `hitl/`;
- an output for "answer admitted", which the event lifecycle publishes as `response.admitted`.

## What stays

These parts are mostly essential, and unlikely to shrink much:

- **model-call plumbing:** provider errors and recovery;
- **durability and handoff:** sessions move between deployments by checkpoint, so the program counter has to be data, not a JavaScript stack;
- **human-input policy rules:** response policies, gated responses, budgets;
- **compaction;**
- **task semantics.**

## Toward a session log

The cuts above keep state in checkpoints, consistent through one commit path. The longer-run direction is a session log from which all of it is derived. [`session-event-lifecycle.md`](./session-event-lifecycle.md#toward-a-session-log) sketches the log's private entries; on the machine side:

- **Commits append entries, and state is folded from them.** A transition produces entries, and the projection, model context, resolved capabilities, and open work are folds. One commit path, lifecycle only in the projection, and one suspension record are smaller versions of the same move.
- **Steps pass positions, not state.** Today every step journals the complete `SessionStepState`. With a log, a step receives a position and a snapshot reference, folds the suffix, acts, and commits.
- **Checkpoints become snapshots,** `{position, foldVersion, state}`, written periodically and at handoff. A fold-version mismatch folds again from an earlier snapshot.
- **Recovery reads the truth.** A retried step sees exactly what it committed, and the projection's counter can't drift from the stream. Zombie writers can still interleave; a conditional append ("expected position N") would be the natural fence if Workflow offers one.
- **Participants record results as entries.** Restores rebuild code from them, and redeploys re-run session-scoped participants with the original `session.started` ([`dynamic-participants.md`](./dynamic-participants.md)).
- **Compaction stops being destructive,** because raw history stays in the log. That's what rewinding past a compaction needs.

**After 1.0, without breaking clients.** The public view keeps producing exactly the v27 facts, so clients, hooks, and channels see nothing change.

- Live sessions migrate at handoff, which already happens only while a session is idle and already upgrades old checkpoints. The upgrade writes a genesis snapshot, and appends continue from there. History before it is unavailable, and rewinding past it settles `refused` with `context-unavailable`.
- Each kind of private state moves separately, in minors: write entries alongside the existing key, compare the fold against it, switch the readers, and delete the key.

**What's hard, in order:**

1. **Deriving model history exactly.** It has to reproduce the same provider input, or prompt caching misses (`harness/prompt-cache.ts`), including provider metadata, `toModelOutput` transforms, announcements, and today's compaction behavior.
2. **Snapshots on Workflow:** where they live, and what reading a log suffix costs per step.
3. **Volume:** about 55 framework context keys, and about 235 non-test `ctx.get`, `set`, and `require` call sites.
4. **Behavior authors notice.** Resolvers run less often, because restores stop running them again.

As a judgment, not an estimate from reading code line by line, this is comparable to the event break in lines touched, spread across releases. Meanwhile, new private state should be entry-shaped: it goes through the commit path as records that could become entries, even while it's stored in checkpoints. Each new ad hoc context key is a future migration.

## Open questions

1. **Does the executor prototype come out clean enough to land before the break?** If it does, call outcomes are exact from v27.0. If not, it isn't on the critical path.
2. **Does any product still need the legacy session import?**
