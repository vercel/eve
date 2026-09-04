---
issue: none
status: proposed
last_updated: "2026-09-04"
---

# Stable session storage, a small holder, and independent turns

Replace the session's parent execution loop with a small **holding workflow** and
independent terminating turn workflows. The holder creates the session resources,
claims its addresses, and durably starts the first turn. Later ingress starts turn
candidates directly. The session's active-turn hook selects the execution owner;
that owner handles input, tools, steering, and finalization through one inbox.

Assume the forthcoming Workflow SDK supports writing from a step to another run's
stream using a stable identifier. We do not need serialized writable handles or a
handle-discovery workaround. Wrap this capability in eve-owned storage interfaces
so the execution model does not depend on Workflow's stream representation.

For the first version, the holder stays pinned for the session's lifetime. Its
only command is additive `rekey`. There is no holder replacement protocol,
generation negotiation, or upgrade coordinator in the main design. New turns run
on the deployment that accepted their input; the holder does not interpret their
state. A small migration extension for existing sessions appears near the bottom.

This proposal covers the inbox, steering, finalization, tool, task, and delivery
contracts together.
The implementation detail here is intentional: replace the old ownership machinery
with explicit interfaces, rather than retain both orchestration systems behind a
new facade. The interfaces below are proposed internal eve APIs, not new public SDK
exports or claims about the forthcoming Workflow API's exact spelling.

## Exactly what the holder holds

| Resource                      | Holder's responsibility                                                                      | Who uses or interprets it afterward                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Provider and callback hooks   | Retain an array/map of claimed hook handles; add another on `rekey`.                         | Ingress looks up a token to find this holder and resolve the session. These hooks do not receive ordinary turn input. |
| One control hook              | Read the frozen `rekey` command and return its claim result.                                 | Turn workflows request registration through this address.                                                             |
| Primary event stream          | Create it once, or keep the supplied existing stream reference.                              | Turn steps append events; clients read and resume with a cursor.                                                      |
| Snapshot stream               | Create it once, or keep the supplied existing snapshot reference.                            | Turn steps append committed snapshots and restore them at subsequent starts.                                          |
| Immutable resource descriptor | Publish the session, holder, stream, and control references once.                            | Ingress, readers, and turn workflows resolve identifiers without assuming they are equal.                             |
| Initial dispatch input        | Retain the accepted first input in durable workflow input and start it after initialization. | The first candidate takes over delivery and execution responsibility.                                                 |

The last two are the additions to the basic hooks-plus-two-streams picture. The
descriptor is small immutable metadata. Initial dispatch is a one-time obligation,
not an inbox of future turns. Neither becomes a mutable copy of session state.

The holder does not retain the latest snapshot in its workflow variables, track
an active model turn, decode event or snapshot payloads, supervise tools, relay
messages, run authored lifecycle hooks, or adopt completed turn results. The actual
session data lives in storage, even when that storage was created by its run.
After bootstrap, only address claims and their acknowledgements grow its history.
Limits on aliases and command delivery still apply.

A holder is a resource holder, not a watchdog for model execution. Keep the name
`holdingWorkflow` so it does not imply a supervision responsibility it lacks.

## Identities and storage references

Use distinct types even when the first implementation derives several values from
one Workflow run ID. A public session ID, holder run ID, turn run ID, event stream
ID, snapshot stream ID, and logical turn ID answer different questions.

```ts
type Id<K extends string> = string & { readonly __kind: K };
type SessionId = Id<"session">;
type WorkflowRunId = Id<"workflow-run">;
type EventStreamId = Id<"event-stream">;
type SnapshotStreamId = Id<"snapshot-stream">;
type EventCursor = Id<"event-cursor">;
type EventKey = Id<"event">;

type EventStreamRef = Readonly<{ id: EventStreamId }>;
type SnapshotStreamRef = Readonly<{ id: SnapshotStreamId }>;

interface SessionResources {
  readonly version: 1;
  readonly sessionId: SessionId;
  readonly holderRunId: WorkflowRunId;
  readonly events: EventStreamRef;
  readonly snapshots: SnapshotStreamRef;
  readonly control: InboxAddress;
  readonly initialEvent?: EventKey;
}
```

References are serializable data, not live `WritableStream` objects. Only the
storage adapter knows whether an ID encodes a run plus namespace, refers to a
separate storage object, or needs a lookup. Neither turn code nor the harness
constructs a stream ID from `sessionId` or substitutes `holderRunId` for it.
Event cursors belong to their event stream and cannot address snapshots.

The descriptor needs an explicit persistence location. The initial Workflow adapter
publishes it once in a closed `eve.session.resources` namespace on the holder run.
That is a **small third metadata stream**, not another continually written log; it
contains references, never writer handles or turn state. This uses an existing
primitive without adding a database. Only the directory adapter knows this layout.

```ts
interface SessionDirectory {
  resolveSession(id: SessionId): Promise<SessionResources>;
  resolveHolder(id: WorkflowRunId): Promise<SessionResources>;
}
```

Initially, the directory may interpret a run-derived public session ID to locate
that descriptor. Provider lookup already returns a holder run ID. A future ID
allocator or directory store can change this mapping without changing callers.
Descriptors remain readable after hook disposal so historical session streams do
not require a live holder. The descriptor is published only after resource and
initial address setup; resolution before readiness waits with a bound or returns
a visible initialization failure.

The active-turn token derives from `sessionId`, not from a candidate or logical
turn. A forwarding candidate might never execute a logical turn. New execution
uses the accepting deployment; steering an already active turn uses that owner's
deployment and supported inbox protocol. Queued input retains its accepting
deployment. None of these decisions requires upgrading the holder.

## Storage and snapshot interfaces

Separate the event log from durable program state. Reuse existing eve event and
session types, but remove the transport from them. These interfaces run in server
or step context; only their data crosses a Workflow boundary.

```ts
interface SessionEvents {
  append(ref: EventStreamRef, events: readonly MessageStreamEvent[]): Promise<void>;
  read(ref: EventStreamRef, after?: EventCursor): ReadableStream<MessageStreamEvent>;
  tail(ref: EventStreamRef): Promise<EventCursor | undefined>;
  close(ref: EventStreamRef): Promise<void>;
}

interface SessionSnapshots {
  latest(ref: SnapshotStreamRef): Promise<SessionCheckpoint | undefined>;
  append(ref: SnapshotStreamRef, checkpoint: SessionCheckpoint): Promise<void>;
  close(ref: SnapshotStreamRef): Promise<void>;
}

interface SessionCheckpoint {
  readonly version: number;
  readonly revision: number;
  readonly writeId: string;
  readonly writerRunId: WorkflowRunId;
  readonly session: DurableSessionSnapshot;
  readonly serializedContext: Record<string, unknown>;
  readonly emission: HarnessEmissionState;
  readonly execution: SessionExecutionState;
  readonly deliveries: DeliveryState;
  readonly obligations: SessionObligations;
}
```

`SessionExecutionState` records session/turn status, the active owner and whether
its previous work settled cleanly. `DeliveryState` holds ordered admitted input
and applied, retired, or queued event identities. `SessionObligations` preserves
pending tools/tasks, asks, authorization, runtime responses, and callers, reusing
existing domain records or their durable references. These must survive a turn;
they are not extra fields for the holder to understand.

Snapshot schema and hydration belong to turn code. Restore after winning the
active-turn claim, refresh the agent from the accepting deployment, and continue
with the committed state. An empty snapshot stream is valid only for the designated
initial event; that turn creates the initial session state. A follow-up that wins
too early releases its claim and waits for bootstrap instead of initializing its
own session or blocking the first turn.

`append` means durable append, not compare-and-swap or an atomic transaction across
two streams. Event IDs and checkpoint write IDs remain stable on retry. The turn
commit boundary flushes events, writes a complete checkpoint, and accounts for
its input before releasing ownership. Reconcile an incomplete predecessor before
another writer proceeds; a stale step must not be mistaken for a newer committed
snapshot. The delivery/failure section specifies the remaining proof obligations.

The Workflow adapter owns ID resolution, serialization, encryption, flush/close,
and cursor translation. It uses the assumed SDK operation for writes by ID. We do
not invent an SDK method signature in this plan. No generic storage plugin registry
is needed now; these two narrow modules provide the substitution point for a future
stream primitive. Preserve the existing public stream format and cursor behavior
through the channel adapter, including its current numeric `startIndex` API.

## The holder's input and only command

```ts
interface HoldingWorkflowInput {
  readonly initialAddresses: readonly string[];
  readonly firstTurn?: AcceptedSubmission;
  readonly existing?: {
    readonly sessionId?: SessionId;
    readonly events?: EventStreamRef;
    readonly snapshots?: SnapshotStreamRef;
  };
}

type HolderCommand = {
  readonly kind: "rekey";
  readonly requestId: string;
  readonly token: string;
  readonly replyTo: InboxAddress;
};

type RekeyResult = {
  readonly kind: "rekey.result";
  readonly requestId: string;
  readonly token: string;
  readonly status: "claimed" | "conflict" | "limit";
};
```

`AcceptedSubmission` is a versioned, serializable input envelope plus accepting
deployment and any initial session seed. The holder passes it through to the
start step without decoding agent state. Ordinary session creation supplies
`firstTurn`; optional existing resources are reserved for migration below.
Resource initialization creates only missing streams and never truncates supplied
ones. The descriptor's `initialEvent` enforces first-input precedence.

The holder's durable body should read like this sequence:

```text
allocate session/resource references and create missing streams
create the control hook and claim initial aliases
publish the immutable resource descriptor
start firstTurn in a durable step, when supplied
for each rekey command:
  claim and retain the additional alias
  reply with claimed / conflict / limit through replyTo
on holder teardown: release hooks; do not emit or close session streams
```

The steps are separate durable boundaries, so the first turn cannot run before
resource setup completes. Hooks are claimed in workflow context; storage, reply
sends, and workflow starts run in steps. Retrying the first start preserves its
submission identity. The holder never awaits that turn's result.

Repeated rekey to an already held token succeeds without allocating another hook.
A conflicting or over-limit claim replies with that result and leaves the holder
and all existing aliases intact. Infrastructure errors follow durable retry/failure
handling. A reply uses the requesting owner's existing inbox; it adds no reply
hook. Reply identities derive from the request ID, and claim success is established
before the acknowledgement. The tiny command/result contract is frozen in v1;
new turn code must remain able to speak it.
Commands and results use the shared inbox envelope at frozen version 1; its
framework-owned event identity and target are not duplicated in these payloads.

## Turn execution interfaces

Keep routing, transport, and the turn state machine separate. The workflow boundary
receives resources and an accepted submission; it does not receive parent state,
a parent writable, a completion token, or a result-return address.

```ts
interface TurnWorkflowInput {
  readonly version: 1;
  readonly session: SessionResources;
  readonly submission: AcceptedSubmission;
}

type InboxClaim =
  { readonly kind: "owned" } | { readonly kind: "conflict"; readonly runId: WorkflowRunId };

interface OwnerInbox {
  readonly address: InboxAddress;
  claim(): Promise<InboxClaim>;
  drain(): readonly InboxEnvelope[];
  next(): Promise<InboxEnvelope>;
  response(requestId: string): Promise<InboxEnvelope>;
  dispose(): Promise<void>;
}
```

Constructing an inbox creates its reader before any claim. Its pump buffers and
correlates arrivals during foreground work; owner-specific control handling signals
cancellation promptly. The inbox does not load snapshots, select deployments, or
run model work. A turn reducer decides what each decoded event means.

The claimed execution path has four operations: restore state, reduce input, run
the next step/wait, and finalize/commit. A single eve-owned turn executor serves
HTTP, provider, task-update, and callback admission. The harness receives hydrated
state and an eve event sink inside a step and returns progress/settlement proposals.
It knows neither holder runs nor Workflow streams. A terminating candidate is also
responsible for forwarding and accounting for its original input when it loses
the claim; the protocol below is part of this interface, not a discarded loser path.

The state-machine boundary should also be explicit:

```ts
type TurnDecision =
  | { readonly kind: "continue"; readonly state: TurnState; readonly work: TurnWork }
  | { readonly kind: "finalize"; readonly settlement: TurnSettlement };

declare function reduceTurnBoundary(input: {
  state: TurnState;
  result: TurnStepResult;
  pending: readonly InboxEnvelope[];
}): TurnDecision;

declare function finalizeTurnStep(input: {
  session: SessionResources;
  settlement: TurnSettlement;
}): Promise<TurnReceipt>;
```

`TurnWork` covers the next model/tool operation or required wait. `TurnSettlement`
is immutable finalizer input, including the terminal decision, resulting state,
and delivery dispositions. `TurnReceipt` references the committed revision and
its input accounting, letting forwarding candidates observe settlement without a
parent result hook. The reducer is pure; the finalizer performs the existing
lifecycle/effect work and commits it. These domain types are developed alongside
their reducers rather than exposing Workflow results as the domain model.

```text
POST /session -> holder -> resources ready -> first candidate
follow-up ----> resolve resources ----------> candidate
provider ----> alias lookup -> descriptor --> candidate
                                              |
                                       claim active-turn(sessionId)
                                        |                    |
                                  claim won              claim lost
                                        |                    |
                               restore -> execute       forward + account
                                      |                       |
                           events + snapshot append     retry when needed
                                      |
                               settle and terminate
```

## Session creation and ingress

HTTP creation performs one start: `holdingWorkflow(createInput)`, whose durable
input includes the initial event and its identity. The holder completes resource
initialization before a separate durable step starts the first turn. Initialization
must finish stream creation, descriptor publication, and required address claims.
Calling `getWritable()` alone is not a readiness barrier. The holder creates the
snapshot storage; the first claiming turn initializes its session contents.

This ordering prevents the first turn from outrunning its stream and lets dispatch
retry after the HTTP request ends. Retries preserve the initial event ID. Early
follow-ups must wait for bootstrap admission or observe the initial event's first
position in durable state; they cannot overtake it. Bootstrap failures remain
visible after an HTTP response has returned. The holder neither awaits the first
turn's completion nor dispatches later turns.

After bootstrap, authorized session ingress starts a candidate directly. Provider
ingress resolves its continuation alias to the current holder, reads the stable
session reference, and takes the same path. Tokens include the full provider
conversation scope; Slack needs installation/workspace, channel, and
`threadTs ?? ts`, not a timestamp alone.

Concurrent first provider messages may start competing holders. Claim the provider
address before agent effects; the loser resolves the winning session and transfers
its initial and buffered input through candidate admission, preserving delivery
responsibility until acknowledged. Startup conflicts are part of the first
version; transferring a live session between holders is follow-up work.

Rekey means **claim another address** through the holder's control inbox. Success
requires a durable claim and an acknowledgement or confirming lookup. Repeating
an address owned by the same holder is a no-op; an address belonging to another
session is a visible conflict. Previously claimed addresses remain until session
closure. Threadless Slack sessions register their thread after the first post
returns its timestamp; the post/claim interval needs startup
reconciliation so a racing reply cannot create a second executing session.

Authorization uses one random, session-scoped callback capability with at least
128 bits of entropy, registered before exposing a challenge URL. Its alias survives
turn completion. Callback ingress accepts bounded parameters, resolves the
session, and admits only an `authorization.response`; it cannot select
arbitrary tokens or event kinds. The reducer matches the pending connection and
attempt, and the connection strategy validates provider state. Secrets and
capabilities stay out of logs.

Task updates, late input responses, cancel, clear, compact, reset, and timeout also
use session admission when no turn is active. A candidate can process control or
settle an obligation without starting a model request. Blocking-tool traffic goes
directly to its active turn's inbox. Ordinary provider and callback events do not
wake the holder.

## One logical inbox per receiving owner

A logical inbox owns its readers, shared buffer, correlations, and wire decoder.
The receiving owner supplies the domain reducer. Each receiving hook has one reader
and accepts the owner's discriminated protocol.
Additional hooks reserve distinct addresses or address independent executions;
message kinds and request IDs do not create hooks. All eve-owned hooks are
server-only (`isWebhook: false`) and omit `HookOptions.metadata`.

| Owner/address          | Proposed token or scope                    | Purpose                                                                   |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Holder control         | `eve:session-control:v1:<sessionId>`       | Additive rekey and its acknowledgement                                    |
| Provider alias         | `eve:continuation:v1:<provider-address>`   | Lookup of the current holder and stable session reference                 |
| Authorization alias    | `eve:auth-callback:v1:<random-capability>` | Authorized callback lookup independent of the active turn                 |
| Active turn            | `eve:turn-inbox:v1:<sessionId>`            | Session-wide exclusion and active-owner input, reports, requests, replies |
| Blocking workflow tool | `eve:workflow-tool-inbox:v1:<operationId>` | One independently executing authored body                                 |
| Background task        | `eve:task-inbox:v1:<taskId>`               | Work and requests that can outlive the initiating turn                    |
| Activity collector     | Existing random callback capability        | Independent batch reduction, debounce, and expiry                         |

Provider and authorization hooks are **lookup-only aliases**. Only receiving
hooks feed an inbox; an alias's job is to reserve an address.
Holder control requests use correlated results or confirming reads without creating
per-request reply hooks.

A session with `C` provider addresses and `A` callback aliases owns `1 + C + A`
holder hooks while idle, plus one claimed turn hook while executing. Each blocking
tool, background task, or collector adds one. Counts exclude authored hooks and any
independent recovery execution. There is no parent turn inbox or
per-kind control/report/reply hook, and no inline-to-child promotion. Every input
still incurs candidate start/claim work, including steering that ultimately runs
in an existing owner; fewer hooks do not establish a latency win.

## Delivery, checkpoints, and failure

A candidate creates its inbox reader before awaiting `getConflict()`. Only a claim
winner loads mutable state and executes. It reads the latest checkpoint **after**
acquiring ownership. Only a definite ownership conflict selects forwarding;
infrastructure errors are failures, not evidence of another healthy turn.

On conflict, forward the same event identity and follow the **actual resumed run**:
the owner can change between `getConflict()` and `resumeHook()`. A definite missing
hook permits bounded claim retries. An ambiguous send error retains the input and
identity. An idle gap in the turn token is safe because it is neither the session
lookup address nor the stream identity.

Successful resume proves durable receipt, not application. An owner can receive
a message after its last application decision and then complete without applying
it. A loser must retain delivery responsibility after `resumeHook()` succeeds.

The candidate protocol therefore retains input until a committed disposition:

1. Start input carries a stable event identity. Forwarding, start retries, and
   recovery preserve it, including retries after an earlier turn has finished.
2. The owner commits applied, conclusively retired, and queued event identities
   with its resulting state. The first prototype follows owner settlement through
   its run result and checkpoint; a hook receipt is never the acknowledgement.
3. Queued input remains the originating candidate's responsibility. A checkpoint
   alone does not schedule it. The candidate stays alive until application,
   retirement, or acknowledged transfer to another durable executor.
4. After a clean settlement that did not consume its input, the candidate competes
   again and respects the committed queue order. A winner for a later event must
   not bypass earlier admitted input. Concurrent starts do not imply FIFO before
   admission; preserve each source's persisted order and record owner admission
   order. Initial input always precedes follow-ups.
5. A failed owner requires reconciliation before further agent effects. Retain
   the last committed state and unresolved input; never silently replay uncertain
   model/tool work or manufacture a second terminal outcome.

The current [session store](../packages/eve/src/execution/durable-session-store.ts)
uses Workflow step results and a parent state cursor. Its old `eve.session` stream
is a fallback, not today's write path. Removing that parent requires a checkpoint
readable by stable session ID. It contains the session snapshot, serialized context,
emission counters, queued input and delivery accounting, pending tasks/asks/auth and
runtime obligations, terminal state, and owner/revision information.

Flush output and publish the complete checkpoint before ordinary ownership release.
Revisions and retry identities must reject stale commits. Hard cancellation needs
fencing or reconciliation that prevents a new owner from proceeding while an old
step can still write. An append-only stream by itself supplies neither transactional
commit nor exactly-once external effects. Turn code performs checkpoint migration;
the holder treats the contents as opaque.

Every owner awaiting another execution's outcome needs durable supervision that
runs independently of new input and session expiry. Workflow sleep and bounded
status reads follow the actual owning run and allow a reconciliation interval for
delayed outcomes. Missing outcomes or exhausted observation budgets fail visibly
without discarding state; healthy suspended work remains running.

Removing the parent also removes its supervision of failed candidates. Candidate
settlement tracking alone does not recover a candidate that itself fails. Before
shipping, prove a durable terminal-run/recovery mechanism that detects stranded
input without another message, including bootstrap failure. It may use a finite
recovery execution; it must not reintroduce an agent loop or per-turn settlement
relay in the holder. This is a release gate, together with fencing and candidate
acknowledgement cost. Supervision remains enabled when `sessionTimeoutMs: false`.

## Wire protocol and inbox pump

Internal senders receive `InboxAddress { token, protocol: { family: "eve-inbox",
version: N } }` or a stable session destination for traffic that may outlive a turn.
The envelope contains `version`, identity `(producer.id, eventId)`, target, and a
discriminated event with its domain payload. Token `:v1:` identifies the topology;
envelope versions evolve independently.

| Events                                                                 | Recipient and correlation                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `message` (`queue`, `steer`, `interrupt`), `owner.cancel`              | Active turn or addressed task/body; session admission binds active-turn targets |
| `session.clear`, `session.compact`, `session.reset`, `session.timeout` | Serialized session candidate                                                    |
| `input.response`, `authorization.response`, `runtime.result`           | Matching live request, connection/attempt, or invocation                        |
| `workflow.report`, `workflow.request`, `workflow.outcome`              | Active turn or task inbox, with operation/request identity                      |
| `activity.batch`                                                       | Collector, with batch identity                                                  |
| `rekey`, `rekey.result`                                                | Holder control and requesting owner inbox, with request identity                |

There is no parent `turn.settled` exchange. Committed state and event dispositions
replace parent adoption. Framework encoders own identity, targets, and capabilities;
client payloads cannot override them. Resource authorization precedes lookup and
admission. Mixed content and input answers become separate ordered events, retaining
both. Pure answers do not accidentally become steering messages.

Durable sends derive IDs from the step and logical send key, never the attempt.
Provider IDs are namespaced; HTTP ingress mints an ID before retryable work. A new
HTTP request remains a new submission, without a new public idempotency-key API.
Deduplication spans aliases, candidates, and turns for the
automatic retry horizon. Pending correlations and unacknowledged input remain
protected across ownership release. Bound address count, bytes, buffers, waiters,
dedupe state, retries, and supervision reads; overflow fails visibly without
evicting input or releasing previous addresses.

Use frozen, append-only wire modules with server/step encoders and dependency-free
workflow decoders, following [wire schemas](./session-inbox-wire-schema.md).
Unsupported versions, kinds, or owner/target combinations fail explicitly; stale
valid events follow domain rules. This plan supersedes that document's routing
and pre-cut compatibility policy where they conflict.

One background pump merges receiving hook iterators while foreground work awaits
steps, tools, sleep, claims, or authored bodies. It decodes, deduplicates, buffers,
wakes correlated waiters, and signals the active abort scope. The foreground
boundary reducer owns state and lifecycle decisions. Dynamic registration wakes an
idle merge, and same-owner registration is idempotent. Preserve each hook's durable
order and deterministic replay relative to foreground settlement; promise completion
timing alone is not an ordering contract across hooks.

Pump failure aborts active work and wakes every waiter as an owner failure.
Disposal releases waiters without requiring future input and follows terminal-state
and pending-input accounting. Readers, pending receives, registration, cancellation,
and disposal under Workflow replay still require Workflow-backed validation.

## Steering and owner finalization

| Input during an active turn | Active step    | Boundary behavior                                                                                  |
| --------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `queue`                     | Continues      | Adopt its result; retain input for a later turn.                                                   |
| `steer`                     | Continues      | Adopt its result; inject eligible input under the same logical turn ID.                            |
| `interrupt`                 | Receives abort | Discard uncommitted output; finalize interruption and admit replacement input under a new turn ID. |
| Matching cancel             | Receives abort | Discard unfinished output and finalize cancellation.                                               |

`DEFAULT_TURN_POLICY` remains `steer`, now meaning step-boundary steering. Callers
requiring abort-and-replace choose `interrupt`. Matching cancel wins over interrupt;
otherwise the first interrupt supplies replacement input and later input stays
queued. Eligible steers coalesce in recorded inbox order and prevent natural
completion. Required sleep, task dispatch, authorization, human input, and runtime
results remain obligations. Stale cancels are discarded; stale messages queue;
responses settle only matching live requests. Clear/compact queue, while reset
aborts the active scope and applies existing reset semantics.

One abort scope spans a turn or authored body, including waits. New scopes inspect
buffered matching controls before work. Abort is cooperative: streamed output and
completed effects cannot be undone. Accepted input, admitted tasks, usage, and
existing cancellation-state carve-outs survive. Ordinary cancellation preserves
tasks; `cancel({ tasks: true })` also cancels session tasks while no turn is active.

The harness returns a settlement proposal with its turn ID and emission state
open. Progress streams immediately. Terminal results, turn/session events, adapter,
memory, dynamic-definition, and authored lifecycle effects wait for the owner's
decision. The shared finalizer lives in `eve` and runs in the winning turn on its
accepting deployment, committing lifecycle-induced state as well as model state.

Scheduling its durable finalization step with immutable input fixes the decision.
A steer accepted by that owner before this boundary continues the turn. Later
input belongs to another turn; receipt by ingress or a forwarding candidate alone
does not establish timely steering. Finalization and delivery accounting must agree
on that boundary without losing events arriving during the final step.

Interruption emits `turn.interrupted` with `sequence` and `turnId`, followed by the
replacement execution's `turn.started`, without `session.waiting` between them.
The prior execution commits the replacement obligation and terminates; the
responsible candidate executes it next. Cancellation retains `turn.cancelled` then
`session.waiting`. Logical terminal event IDs and timestamps survive retries;
transport writes can redeliver those IDs. Preserve usage, structured results, and
external-effect idempotency. Turn completion releases resources without closing
the shared stream.

## Workflow tools, tasks, and input

A blocking workflow tool keeps one independent execution and inbox for its authored
body. Reports, requests, and outcomes go directly to the active turn; replies and
cancellation return directly to the tool. There is no holder relay. Background
execution runs in its task owner without another workflow-tool wrapper; updates
and requests use stable session admission because the initiating turn may be gone.
Task state and subagent body placement follow
[executor-neutral boundaries](./executor-neutral-core.md). Removing top-level
session/turn parenting does not remove actual tool, task, or subagent relationships.

`ask()` returns an eve-owned `Promise<ToolInputResponse>` backed by request-ID
correlation in the tool/task inbox. Awaiting, concurrent asks, and races with
Workflow `sleep` remain supported. Remove Hook-specific token, iterator, claim,
and disposal members from this public API.

Track request sends: failure rejects the ask. Buffer early replies, consume answers
once, and isolate concurrent requests. A winning sleep race does not withdraw the
ask; it stays answerable until answered or the body settles. Body settlement
withdraws unresolved requests and releases waiters. Cancellation preserves the
30-second grace period for authored code ignoring its abort signal. Agent replies
use `runtime.result`; collectors retain debounce and expiry. Application-authored
`createHook` and `createWebhook` remain unchanged.

## What the implementation removes

Build the new path around the interfaces above, then remove the superseded path.
Do not preserve inline/child mode switches, parent acknowledgements, or old token
routing as hidden implementations of the new interfaces. Migration adapters, when
needed, live outside the normal execution path.

| Existing machinery                                                                                                                                                                                                                                                                       | Replacement or retained responsibility                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`workflow-entry.ts`](../packages/eve/src/execution/workflow-entry.ts): `runDriverLoop`, parked input routing, mutable crash-cleanup mirror                                                                                                                                              | `holdingWorkflow` keeps resources and aliases; the terminating executor owns session work and failure handling.                                                      |
| [`turn-dispatch.ts`](../packages/eve/src/execution/turn-dispatch.ts), [`inline-turn.ts`](../packages/eve/src/execution/inline-turn.ts), and the dual paths in [`turn-workflow.ts`](../packages/eve/src/execution/turn-workflow.ts)                                                       | One candidate entrypoint and one claimed turn executor; remove inline promotion and dispatch-and-await-child behavior.                                               |
| [`turn-control-receiver.ts`](../packages/eve/src/execution/turn-control-receiver.ts), [`turn-control-protocol.ts`](../packages/eve/src/execution/turn-control-protocol.ts), parent notifications in [`turn-execution-cursor.ts`](../packages/eve/src/execution/turn-execution-cursor.ts) | Session-scoped owner inbox plus committed delivery dispositions; remove completion-token exchanges, parent state returns, and continuation relays.                   |
| [`session-state-cursor.ts`](../packages/eve/src/execution/session-state-cursor.ts) and [`durable-session-store.ts`](../packages/eve/src/execution/durable-session-store.ts) transport responsibilities                                                                                   | `SessionSnapshots` plus a turn-local state value. Retain projection/hydration logic; remove parent-owned persistence and the ordinary path's legacy stream fallback. |
| [`session-command-inbox.ts`](../packages/eve/src/execution/session-command-inbox.ts)                                                                                                                                                                                                     | Small holder address collection and generic `OwnerInbox`; provider aliases perform lookup and the turn inbox receives traffic.                                       |
| [`tools/workflow/owner.ts`](../packages/eve/src/execution/tools/workflow/owner.ts), per-kind channels, separate turn cancellation hook                                                                                                                                                   | One receiving inbox per independent tool/task/turn owner, with discriminated events and request correlations.                                                        |
| `parentWritable` through turn/coordination/terminal step inputs                                                                                                                                                                                                                          | `EventStreamRef` at durable boundaries and an eve event sink inside executing steps. Stream decoding and Workflow serialization stay in the storage adapter.         |
| [`workflow-entry-finalization.ts`](../packages/eve/src/execution/workflow-entry-finalization.ts) and premature terminal emission in [`harness/emission.ts`](../packages/eve/src/harness/emission.ts)                                                                                     | One turn-owned finalizer after the inbox decision; preserve authored lifecycle behavior, usage, caller notification, and actual task/subagent supervision.           |
| Session/channel code that treats a session ID as a stream/run ID                                                                                                                                                                                                                         | `SessionDirectory` for resolution, then `SessionEvents` or `SessionSnapshots` for the operation.                                                                     |

Suggested module boundaries are `session/resources`, `session/storage`,
`session/holding-workflow`, `inbox/owner-inbox`, and `turn/{workflow,execute,reduce,finalize}`.
These are responsibilities to keep small, not a requirement for a class or framework
at each boundary. Storage and domain modules stay free of durable workflow control;
only the workflow adapter touches SDK stream and hook primitives. Reuse domain
logic that already implements hydration, tools, tasks, emissions, or authorization;
remove the obsolete coordination around it.

## Session lifetime and cleanup

Turn completion keeps the event/snapshot streams and holder alive. True session
termination is owned by terminating execution: stop admission in committed state,
settle or cancel dependants, account for pending input, run authored lifecycle work,
and flush terminal output. Then close storage and dispose the holder through the
execution adapter. Disposal uses Workflow run control, not a new holder command.
The holder's teardown only releases its hooks; it does not decode snapshots or
emit a terminal event. Cleanup retries and late rekey must not resurrect a terminal
session or strand its resources; verify that boundary explicitly.

Session status comes from committed state plus current execution status, not from
the fact that the holding run is still alive. Idle expiry and execution supervision
remain outside the holder's rekey loop. Preserve the existing timeout policy and
durable scheduling; disabling session expiry does not disable failure detection.
A small holder does not by itself solve those execution responsibilities.

## Migration and upgrades after the first version

The first version assumes the holder is never upgraded. Turn code can evolve while
continuing to read the supported resource descriptor and speak the frozen rekey
contract. Snapshot migrations run in the accepting turn, not in the holder. This
keeps normal deployment changes out of long-lived workflow code.

Keep the optional existing-resource input as the starting point for moving older
eve sessions onto this topology:

```ts
const input: HoldingWorkflowInput = {
  initialAddresses: knownAddresses,
  existing: {
    sessionId: previousSessionId,
    events: previousEventStream,
    snapshots: importedSnapshotStream,
  },
};
```

Supplying an event stream means use that reference and do not create another event
stream. Snapshot storage is independent: reuse a compatible snapshot stream or
create one and import state. A migration-only holder omits `firstTurn`, so adopting
storage does not replay the initial user request. Subsequent turns use the normal
admission path. Keeping the original event reference preserves its history and
cursors; preserving a public session ID additionally requires the directory mapping.

This is an extension point, not a complete live-migration design. Older
`entryWorkflow` versions hold state in step results, so a migration must extract a
valid snapshot and safely stop the old executor before new turns write. Existing
provider claims also need a deliberate handoff; releasing one hook and claiming it
in another run are not atomic. Source-stream retention and encryption material must
remain available. An event reference alone does not solve these issues.

Work through supported legacy versions, public-ID mapping, address transfer, and
recovery after the clean new-session design lands. Do not add holder generations,
automatic replacement, adopt/retire commands, or an upgrade router to v1 to anticipate
that work. Live holder replacement remains outside the first implementation.

## Implementation gates

Implement the new-session topology in the following order. Migration is follow-up
work and does not gate this first version:

| Gate                                   | Required evidence                                                                                                                                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resource contracts and minimal holder  | Distinct session/run/event/snapshot IDs round-trip; resources resolve after initialization and for historical reads; first start follows readiness; only rekey reaches the holder; duplicate/conflicting/bounded aliases preserve existing claims. |
| Durable admission                      | Early follow-ups; duplicate starts after hook release; queue order; late finalization input; actual-owner changes; failed candidates visible without new traffic.                                                                                  |
| Snapshot and execution safety          | Restore/commit/replay; stale writers after hard cancellation; output flush; no duplicate effects or terminal outcomes during recovery; bounded acknowledgement and supervision cost.                                                               |
| Inbox and turn behavior                | Reader registration/replay/disposal; queue/steer/interrupt/cancel precedence at model, tool, sleep, ask, auth, and finalization boundaries; no lost input or premature lifecycle effects.                                                          |
| Tools, late events, and cleanup        | Blocking tool/background task ownership; concurrent asks and runtime replies; send failure/cancellation cleanup; late events while idle; expiry and terminal cleanup without a new holder command.                                                 |
| Stream adapter and end-to-end behavior | Writes by ID through the assumed SDK capability, encrypted cross-deployment reads/writes, cursors, event decoding, closure, deterministic fixtures, and paired hosted latency including starts, claims, snapshots, and forwarding.                 |

Use unit tests for reducers, Workflow-backed scenarios for durable scheduling and
failure boundaries, and CI fixture evals for streaming behavior (`agent-workflow-tools`,
`fixture-tasks`, `agent-channels`). Follow [turn performance](./turn-performance.md)
for paired measurements. The prior successor experiment's continuously owned turn
token is unnecessary here, but durable input ownership remains mandatory. There is
no hosted performance result for this topology yet.

Runtime implementation must update session/storage documentation, steering and
`turn.interrupted` semantics, additive rekey, recovery behavior, and the Promise-based
`ask()` API. Include the public API changes' minor changeset and fixture coverage.
This research-only proposal does not change published behavior.

Source inventory: [session inbox](../packages/eve/src/execution/session-command-inbox.ts),
[turn workflow](../packages/eve/src/execution/turn-workflow.ts),
[tool owner](../packages/eve/src/execution/tools/workflow/owner.ts),
[task workflow](../packages/eve/src/execution/tasks/child/workflow.ts),
[inline turn](../packages/eve/src/execution/inline-turn.ts),
[harness emission](../packages/eve/src/harness/emission.ts), and
[Slack anchoring](../packages/eve/src/public/channels/slack/slackChannel.ts).
