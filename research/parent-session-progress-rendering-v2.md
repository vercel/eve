---
issue: https://github.com/vercel/eve/issues/1673
status: proposed
last_updated: "2026-08-19"
---

# Parent-owned progress rendering

## Summary

Add an opt-in progress path that updates channel presentation without starting
or steering a model turn. Root agents and descendants submit versioned progress
commands to the root session's stable inbox. The root session workflow reduces
those commands into a bounded work graph and passes the graph to configured
channel renderers.

The first release combines two sources:

- the framework reports when delegated work starts and settles;
- agents provide intermediate descriptions through `report_progress`.

```text
execution control                         presentation

root turn                                 root session workflow
  └── child A                               ├── progress inbox
      └── child B                           ├── work-graph reducer
                                            └── channel renderers

B result ─────────► A control path
B progress ───────────────────────────────► root progress path
```

Progress may activate the root session workflow. It must not call a model,
enter conversation history, steer an active turn, or wake an intermediate
parent model.

## Problem

A parent receives a delegated child's terminal result, but the root channel has
no durable path for presenting intermediate child activity. Reconstructing that
activity from child streams would couple presentation to execution internals and
would not cover remote or background work consistently.

The missing boundary is a presentation-only path with three properties:

1. Descendants can address the root presentation owner directly.
2. The framework remains authoritative for structural lifecycle.
3. Channels retain ownership of provider effects and message identity.

## Scope

The first release supports progress from root, local, task-owned, remote, and
nested work. It preserves immediate parent lineage and the originating root
turn, allowing each renderer to choose how to group provider artifacts.

The first release does not:

- forward generic stream events, reasoning, narration, tool output, or child
  results;
- let free-form reports control lifecycle;
- expose a public custom-renderer callback or client progress stream;
- change `task_update`;
- require renderers to use the same artifact grouping;
- migrate renderer state across deployments;
- adopt native Slack task streams.

Without a configured renderer, the progress capability remains absent and
existing channel behavior does not change.

## Ownership model

| Concern                                                  | Owner                                   |
| -------------------------------------------------------- | --------------------------------------- |
| Child result and control flow                            | Immediate parent                        |
| Progress routing                                         | Root session lineage or remote callback |
| Work identity and lifecycle                              | Framework                               |
| Intermediate report text                                 | Agent through `report_progress`         |
| Reduced progress state                                   | Root session driver                     |
| Destination, credentials, provider effects, and recovery | Channel renderer                        |

Routing and identity remain separate. A routing capability determines where a
progress command goes. Framework-stamped work identity determines where the
work belongs in the graph. Neither is model-authored or provider-specific.

The graph stores work facts rather than presentation artifacts. It does not
contain a generic card or group ID. Renderers derive artifact grouping from
work identity and lineage.

## Progress command path

### Command contract

The stable session inbox accepts one versioned command distinct from model
delivery and session control:

```ts
interface SessionProgressCommandV1 {
  readonly kind: "progress";
  readonly version: 1;
  readonly commandId: string;
  readonly events: readonly ProgressEventV1[];
}
```

The inbox recognizes the command and invokes a private handler. It does not
inspect lifecycle policy, renderer configuration, or provider state.

### Parked and active sessions

A parked session consumes a progress command, invokes the handler, and resumes
waiting. It does not produce a next-turn instruction.

During an active turn, the driver races the turn's control hook with the stable
session inbox:

```text
progress arrives
  → handle progress
  → continue waiting for the same turn

turn result arrives later
  → adopt the result normally
```

Progress never enters buffered model deliveries, requests cancellation, or
changes turn steering. Driver-owned progress state remains separate from the
turn-owned context so that adopting a turn result cannot overwrite progress
received while that turn was active.

Handler and renderer failures are isolated from the active turn and parked
session. The driver logs a sanitized diagnostic and continues waiting.

## Work graph

### Identity

Each work item represents one invocation or delegated unit. Repeated calls to
the same agent receive different IDs.

```ts
interface ProgressWorkIdentityV1 {
  readonly id: string;
  readonly parentId?: string;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId?: string;
  readonly kind: "root-turn" | "subagent" | "remote-agent" | "task";
  readonly name?: string;
}
```

`parentId` records the immediate presentation parent. `rootTurnId` records the
root turn that originated the work. A child may arrive before its parent; the
reducer retains the unresolved parent reference until the parent appears.

### Event vocabulary

The initial vocabulary contains only structural lifecycle and explicit reports:

```ts
type ProgressEventV1 =
  ProgressWorkStartedEventV1 | ProgressWorkSettledEventV1 | ProgressReportEventV1;

interface ProgressWorkStartedEventV1 {
  readonly kind: "work.started";
  readonly eventId: string;
  readonly work: ProgressWorkIdentityV1;
  readonly startedAt: string;
}

interface ProgressWorkSettledEventV1 {
  readonly kind: "work.settled";
  readonly eventId: string;
  readonly workId: string;
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly settledAt: string;
}

interface ProgressReportEventV1 {
  readonly kind: "report";
  readonly eventId: string;
  readonly work: ProgressWorkIdentityV1;
  readonly message: string;
  readonly reportedAt: string;
}
```

The model supplies only the report message. The framework stamps identity,
event IDs, and timestamps.

### Reduced state

The root driver owns a bounded, renderer-neutral snapshot:

```ts
interface ProgressSnapshotV1 {
  readonly version: 1;
  readonly revision: number;
  readonly work: Readonly<Record<string, ProgressWorkV1>>;
  readonly recentReports: readonly ProgressReportV1[];
  readonly seenCommandIds: readonly string[];
  readonly seenEventIds: readonly string[];
}

interface ProgressWorkV1 extends ProgressWorkIdentityV1 {
  readonly phase: "running" | "completed" | "failed" | "cancelled";
  readonly startedAt: string;
  readonly settledAt?: string;
  readonly currentReport?: ProgressReportV1;
}
```

The snapshot remains a flat map. Renderers reconstruct hierarchy from
`parentId`.

### Reducer invariants

- Terminal work cannot reopen.
- Reports cannot change structural lifecycle.
- A new report replaces the current report for its work item.
- Settlement clears the live report but may retain bounded history.
- A report received before `work.started` creates running work from its
  framework-stamped identity; a later start merges idempotently.
- Children may appear before parents.
- Settling a parent does not automatically settle active descendants.
- Commands and events deduplicate by stable IDs.
- Work, reports, labels, graph size, history, and deduplication windows remain
  bounded.
- Revision advancement tracks accepted state changes even after a bounded
  deduplication window reaches capacity.

## Progress producers

### Root and local work

The root driver establishes and settles root-turn work directly in driver-owned
state. It does not send those facts through its own inbox.

Delegation owners emit lifecycle at the points where dispatch and settlement
are authoritative:

```text
dispatch accepted → work.started
child terminal    → work.settled
```

The implementation must not observe the entire event stream to infer this
lifecycle.

A descendant inherits the root route and current work identity. When child A
dispatches child B, the framework derives B's ID from A's session, turn, and
call identity; sets B's `parentId` to A's work ID; and preserves the inherited
`rootSessionId` and `rootTurnId`.

### Authored reports

`report_progress` is available only when the root progress capability exists:

```ts
report_progress({ message: "Running the integration suite" });
```

The tool returns after the command is queued. It does not wait for reduction or
provider rendering. `task_update` remains the child-to-parent model
notification mechanism.

Structural lifecycle and authored reports share one private submission helper.
Structural callers ignore submission failures after logging. Authored reports
return a tool error when submission fails before reaching the root handler.

## Remote progress

Remote descendants receive an optional callback capability separate from
terminal and human-in-the-loop callbacks:

```ts
interface ProgressCallbackV1 {
  readonly version: 1;
  readonly token: string;
  readonly url: string;
}
```

The token addresses the root session's stable inbox. The URL uses the existing
authenticated callback route in the root deployment.

A compatible receiver validates the callback before enabling
`report_progress`, then propagates the callback and current work identity to
its descendants. Older receivers ignore the optional field and continue
without intermediate progress.

Remote submissions use a versioned envelope:

```ts
interface RemoteProgressEnvelopeV1 {
  readonly kind: "session.progress";
  readonly version: 1;
  readonly command: SessionProgressCommandV1;
}
```

The callback route validates the full command schema and resumes the route
token directly. It never converts progress into model delivery, task updates,
or model input. An inherited callback always wins; only the root creates one.

## Rendering

The first provider integration introduces a private renderer contract and a
durable rendering step:

```ts
interface ProgressRenderInput<TState> {
  readonly snapshot: ProgressSnapshotV1;
  readonly destination: ChannelProgressDestination;
  readonly state: TState;
}

interface ProgressRenderResult<TState> {
  readonly state: TState;
}
```

A renderer receives the complete bounded graph and owns its provider message
identity and retry metadata. The driver does not pre-group artifacts. A
renderer may choose one status, one artifact per root turn, one per top-level
subtree, or one per work item without changing the command path or reducer.

The initial Slack status renderer selects, in order:

1. the newest report from active work;
2. a neutral label for the newest active delegated work;
3. `Working…` for active root work;
4. an empty status after represented work settles.

A later Slack activity renderer may group one message per root turn and render
a bounded nested work tree. That grouping remains Slack policy, not protocol
state.

Provider failures do not fail execution or final delivery. The driver retains
desired state and renderer-specific retry state. Terminal cleanup requires a
bounded retry or explicit settlement flush; it must not depend on unrelated
future progress.

## Cost gate

Before enabling a production renderer, a scenario-level spike must measure the
cost of activating the root session for progress.

Cover:

- parked and active consumption;
- driver state surviving turn-result adoption;
- 10 and 100 concurrent producers;
- replayed command deduplication;
- user messages, cancellation, reset, and child results under load;
- bounded journal and state growth.

Measure workflow activations, progress-to-handler latency, control-command
latency, journal growth, state growth, and provider writes after coalescing.

If activation cost or control contention is unacceptable, move reduction and
rendering to a dedicated presentation relay. Keep the command vocabulary, work
graph, producers, and renderer contracts unchanged.

## Pull request stack

Each PR should establish one reviewable boundary and avoid introducing policy
owned by a later layer.

| PR                 | Scope                                                                                                                                            | Primary review questions                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Progress inbox  | Add the command discriminator, parked and active consumption, private handler seam, failure isolation, and a test observer.                      | Can progress be consumed without dispatching, steering, cancelling, buffering, or changing history? Is active-turn state independent from the returned turn context? |
| 2. Work graph      | Add event and identity contracts, the bounded reducer, and driver-owned snapshot state. No provider effects.                                     | Are terminal precedence, out-of-order events, deduplication, bounds, and revision semantics deterministic?                                                           |
| 3. Local producers | Add root lifecycle, targeted local dispatch and settlement events, identity propagation, `report_progress`, and the shared submission helper.    | Are lifecycle facts emitted only at authoritative boundaries? Can nested reports reach the root without waking parent models?                                        |
| 4. Remote parity   | Add callback negotiation, validation, propagation, the versioned envelope, and nested remote/local inheritance.                                  | Do compatible and older peers behave safely? Can malformed or replayed callbacks affect model delivery or lifecycle?                                                 |
| 5. Slack status    | Add the private renderer contract, durable rendering step, isolated state, opt-in status configuration, retries, and cleanup.                    | Does Slack own credentials, destination projection, provider identity, and failure recovery? Is unchanged behavior preserved without opt-in?                         |
| 6. Slack activity  | Add Slack-owned root-turn grouping, nested rendering, update-in-place effects, metadata recovery, escaping, bounds, and composition with status. | Can artifact recovery and terminal cleanup survive replay and provider failures without changing the shared graph?                                                   |

Reviewers can evaluate inbox semantics and reducer invariants before considering
producer coverage or provider presentation. Remote transport depends on the
local producer contract; both Slack integrations depend on the stable graph and
renderer boundary.

## Verification strategy

- **Unit:** command parsing, identity derivation, reduction, graph selectors,
  bounds, and renderer projection.
- **Integration:** active and parked routing, local and remote submission,
  callback validation, nested identity propagation, and renderer-state
  isolation.
- **Scenario:** workflow replay, concurrency, control contention, reset,
  cancellation, and the cost gate.
- **E2E:** an opted-in Slack fixture receives root and nested local or remote
  reports and settlement while model invocation count proves no parent turn was
  added.

## Acceptance criteria

- Progress never becomes model input or conversation history.
- Parked and active sessions consume progress without dispatching or steering a
  turn.
- Root, local, task-owned, remote, and nested work share one graph vocabulary.
- Nested work retains its immediate parent and originating root turn.
- Reports route directly to the root presentation owner without waking
  intermediate models.
- The framework emits only lifecycle required to start and settle delegated
  work; agents author all intermediate descriptions through `report_progress`.
- Terminal work cannot reopen, and replay cannot duplicate work or reports.
- Renderers can partition the graph without protocol changes.
- Provider credentials, message IDs, effects, and recovery remain
  channel-owned.
- Provider failures do not fail execution or leave terminal status permanently
  stale.
- Without configured renderers, tool availability and existing channel
  behavior remain unchanged.
- Parent-session activation and control latency remain within an accepted,
  measured budget; otherwise the implementation moves to a presentation relay.
