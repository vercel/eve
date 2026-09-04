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
contracts together. **Implementation means deleting the superseded workflow
orchestration and rebuilding around the contracts below.** Entire implementation
directories may be replaced. Existing internal files, helper signatures, and folder
boundaries have no compatibility requirement. Retain useful domain logic and the
behavioral guarantees this plan specifies; remove the old ownership machinery.

The implementation detail here is intentional: it defines the clean boundaries
to build after that removal. The new interfaces must not delegate to the old
parent loop, inline/child dispatch, or completion-token protocol. They are proposed
internal eve APIs, not new public SDK exports or claims about the forthcoming
Workflow API's exact spelling.

This document is the implementation contract for the replacement. Linked research
provides background on domain boundaries and measurement; its older topology and
compatibility instructions do not override this plan. Storage fencing, recovery
after a failed candidate, and provider bootstrap races still need concrete
mechanisms and evidence. Resolve those implementation gates before shipping; the
local experiments below do not prove the complete runtime.

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
type SnapshotRecordId = Id<"snapshot-record">;
type EventCursor = Id<"event-cursor">;
type EventKey = Id<"event">;

type EventStreamRef = Readonly<{ id: EventStreamId }>;
type SnapshotStreamRef = Readonly<{ id: SnapshotStreamId }>;
type SnapshotRecordRef = Readonly<{ id: SnapshotRecordId }>;

interface InboxAddress {
  readonly token: string;
  readonly ownerRunId: WorkflowRunId;
  readonly protocol: { readonly family: "eve-inbox"; readonly version: number };
}

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
`EventKey` identifies the envelope's `(producer.id, eventId)` pair across retries
and forwarding; it is independent of the candidate run ID.

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
Descriptors remain readable after hook disposal, subject to storage retention and
encryption-key availability, so historical reads do not require a live holder.
The descriptor is published only after resource and initial address setup;
resolution before readiness waits with a bound or returns a visible initialization
failure.

The directory may cache a successfully resolved descriptor by holder run ID within
its storage/project scope. Publish it once and never rewrite it. Additive rekey
does not change the descriptor, so all aliases reuse the same entry. Bound the
cache; do not cache initialization failures as permanent absence. Future changes
to public-ID or alias mappings are separate from this immutable record.

The active-turn token derives from `sessionId`, not from a candidate or logical
turn. A forwarding candidate might never execute a logical turn. New execution
uses the accepting deployment; steering an already active turn uses that owner's
deployment and supported inbox protocol. Queued input retains its accepting
deployment. None of these decisions requires upgrading the holder.

## Storage and snapshot interfaces

Separate the event log from durable program state. Reuse existing eve event and
session types, but remove the transport from them. These interfaces run in server
or step context. Workflow inputs carry resource references; snapshot payloads are
read and used inside executing steps.

```ts
interface SessionEvents {
  append(ref: EventStreamRef, events: readonly MessageStreamEvent[]): Promise<void>;
  read(ref: EventStreamRef, after?: EventCursor): ReadableStream<MessageStreamEvent>;
  tail(ref: EventStreamRef): Promise<EventCursor | undefined>;
  close(ref: EventStreamRef): Promise<void>;
}

interface SessionSnapshots {
  latest(ref: SnapshotStreamRef): Promise<SessionCheckpoint | undefined>;
  read(ref: SnapshotRecordRef): Promise<SessionCheckpoint>;
  append(ref: SnapshotStreamRef, checkpoint: SessionCheckpoint): Promise<SnapshotRecordRef>;
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
its previous work settled cleanly, including the last settled record reference.
An in-progress checkpoint can retain a proposed result without adopting it; its
execution phase distinguishes that proposal from a settled turn. `DeliveryState`
holds ordered admitted input and applied, retired, or queued event identities.
`SessionObligations` preserves pending tools/tasks, asks, authorization, runtime
responses, and callers, reusing existing domain records or their durable references.
These must survive a turn; they are not extra fields for the holder to understand.
Produce one coherent checkpoint from the authoritative domain state; do not keep
independently mutable copies of fields already represented in that state.

Snapshot schema and hydration belong to turn code. Restore after winning the
active-turn claim, refresh the agent from the accepting deployment, and continue
with the committed state. Perform this read inside the first execution step, before
any model or tool effect; do not add a step just to return hydrated state to another
step. Returning the full snapshot from a hydration-only step would persist that
large payload in step history.

Here a committed checkpoint is a durably persisted record; its execution phase
separately records whether the turn has settled and adopted its proposed result.

`latest()` is a bounded read of the current committed checkpoint. It returns
`undefined` for initialized storage with no checkpoint; it must not wait for a
future append while the caller holds execution ownership. A read failure is not
an empty session. Only the descriptor's designated `initialEvent` may initialize
an empty session from its seed. An early follow-up releases its claim before
waiting and competing again, so it cannot block the initial turn. The latest read
bypasses caches; a checkpoint with unfinished work still requires reconciliation
before a new owner performs effects.

`append()` returns an immutable record reference after persistence; retries of the
same write identity must not create a different logical checkpoint. Reusing a write
identity with different content fails visibly instead of replacing its record.
Subsequent execution and finalization steps use `read(recordRef)` to restore that exact state,
not a moving stream tail. These records live in the snapshot storage already held
by the session. No additional holder state or workflow is needed for step handoff.
The adapter owns efficient record addressing; a run ID or stream ID alone cannot
identify a particular checkpoint.
Immutable records may use a bounded cache by record reference within the storage
scope. Hydrating a mutable working state must not mutate the cached record.

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
interface AcceptedSubmission {
  readonly version: 1;
  readonly envelope: Omit<InboxEnvelope, "target">;
  readonly acceptedDeploymentId?: string;
  readonly initial?: InitialSessionSeed;
}

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

`AcceptedSubmission` retains the stable event identity, normalized content or
command, turn policy, and server-validated authorization, delivery, and caller
context in its envelope. Forward the complete submission. The trusted dispatch
adapter binds the target from `SessionResources`; clients do not supply it.
Session-admission encoding also preserves the accepting deployment and initial seed
alongside the normalized envelope; forwarding only the message would lose them.
`InitialSessionSeed` is new-session configuration and initial context, never an
existing session snapshot. Its domain fields come from current channel and
session initialization types.

Stamp `acceptedDeploymentId` at ingress for hosted execution; omission is for
local execution without deployment IDs. Every candidate start, including the
holder's first dispatch and a queued retry, uses that accepting deployment
explicitly. Do not substitute the holder's deployment or resolve "latest" again
when deferred work executes. An unavailable accepting deployment follows visible
failure/recovery handling without silently changing code versions.

The holder passes the submission through without interpreting agent state.
Ordinary creation requires `firstTurn`; omitting it is reserved for migration with
existing resources and imported state. Initialization creates only missing streams
and never truncates supplied ones. The descriptor's `initialEvent` is derived from
the first submission and enforces first-input precedence.

The holder's durable body should read like this sequence:

```text
allocate session/resource references
create the control hook and claim initial aliases
create missing streams after the address claims succeed
publish the immutable resource descriptor
start firstTurn on its accepting deployment in a durable step, when supplied
for each rekey command:
  claim and retain the additional alias
  reply with claimed / conflict / limit through replyTo
on holder teardown: release hooks; do not emit or close session streams
```

Claims and resource publication must complete before the first start. This is an
ordering requirement, not a requirement for a separate step per initialization
operation. Hooks are claimed in workflow context; combine compatible storage work
inside a step, and start the first turn only after readiness is durable. Retrying
that start preserves the submission identity. The holder never awaits the turn's
result and does not receive a settlement callback.

Repeated rekey to an already held token succeeds without allocating another hook.
A conflicting or over-limit claim replies with that result and leaves the holder
and all existing aliases intact. Infrastructure errors follow durable retry/failure
handling. A reply uses the requesting owner's existing inbox; it adds no reply
hook. Reply identities derive from the request ID, and claim success is established
before the acknowledgement. The tiny command/result contract is frozen in v1;
new turn code must remain able to speak it.
If the requesting inbox is already gone, keep the successful alias claim and
continue the holder loop. A missing reply recipient must not fail the holder or
undo a rekey. The requester can confirm ownership by lookup when its reply is lost.
Commands and results use the shared inbox envelope at frozen version 1; its
framework-owned event identity and target are not duplicated in these payloads.

## Turn execution interfaces

Keep routing, transport, and the turn state machine separate. The workflow boundary
receives resources and an accepted submission; it does not receive parent state,
a parent writable, a completion token, or a result-return address.
`session` is required and resolved by trusted server code before `start()`. A turn
does not need a resource-discovery step. HTTP payloads cannot supply these internal
references or bypass resource authorization.

Keep the full snapshot out of `TurnWorkflowInput`, including its submission payload.
Workflow start inputs are persisted for every candidate, including candidates that
only forward steering input. Passing a large snapshot would duplicate it into that
history and increase serialization and transfer costs. Pass its immutable storage
reference; the winning turn reads and uses the snapshot inside its first execution
step.

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

One inbox instance represents one claim attempt. After a conflict, dispose the
unsuccessful claim. Competing again creates a new inbox and reader with the same
session token and the same submission identity. Repeating `getConflict()` on the
old hook observes its recorded conflict; it is not a new ownership attempt.

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
is small immutable finalizer input, including the terminal decision, record
references for the proposed/base state, and delivery dispositions. `TurnReceipt`
contains the committed record reference and bounded dispositions for the owner's
admitted inputs. A forwarding candidate can check its disposition without reading
the full snapshot or waiting on a parent result hook. The reducer is pure; the
finalizer performs the existing lifecycle/effect work and commits it. These domain types are developed alongside
their reducers rather than exposing Workflow results as the domain model.

Keep `TurnState` and `TurnStepResult` limited to control projections and
`SnapshotRecordRef` values at workflow boundaries. Large history, context, and
proposal data stays in snapshot storage and is read inside the step that uses it.
The storage implementation must distinguish proposed state from settled state so
interruption can discard a proposal without losing admitted input or committed
effects. Measure both input and result bytes, including finalization.

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
address before creating session streams or performing agent effects. The loser
resolves the winning holder's descriptor and durably dispatches its initial input
as a candidate for that session, then releases its own claims and terminates. It
does not publish a second session descriptor or start an agent against its unused
resource IDs. Preserve delivery responsibility through that transfer. Conflicting
initial aliases owned by different sessions fail visibly; do not merge sessions.
Startup conflicts are part of v1; live holder transfer is follow-up work.

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

## Read placement and consistency

The common contract is: **channels resolve the holder and immutable resources;
the turn claims execution ownership and reads the latest committed state.** Keep
resolution in the shared channel runtime so HTTP, Slack, task, and callback ingress
do not each implement a discovery protocol. A channel's holder lookup is not an
active-turn ownership claim.

| Read or operation                   | Where it belongs                   | Reason                                                                               |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| Continuation token to holder        | Provider ingress                   | The lookup supplies the holder run ID before candidate start.                        |
| Public session ID to descriptor     | HTTP ingress through the directory | The adapter owns the ID mapping and can reuse its descriptor cache.                  |
| Holder ID to descriptor             | Ingress through the directory      | Resolve once on a cache miss; pass `SessionResources` directly to the candidate.     |
| Latest snapshot and admission state | First execution step, after claim  | History, pending input, and terminal state can change before ownership is acquired.  |
| Event stream for an HTTP response   | HTTP streaming adapter             | Reuse the resolved `events` reference; opening a reader does not hydrate turn state. |

For a new session, the holder already has `SessionResources` after publishing the
descriptor and passes it directly into its first start. There is no discovery read
on that dispatch path. For an existing Slack conversation, the sequence is:

```text
continuation lookup -> holder ID -> cached descriptor or one descriptor read
  -> start({ version: 1, session: resources, submission })
  -> claim active-turn(sessionId)
     owned: first execution step reads snapshot, admits input, and executes work
     conflict: forward and account for input; skip snapshot/model work
```

An HTTP follow-up follows the same contract, entering through
`directory.resolveSession(sessionId)`. Reuse that result for submission and stream
serving within the request. Do not preflight the active-turn hook, read a snapshot
to decide whether a turn is idle, or reread the descriptor inside the candidate.
Those reads cannot reserve ownership. Required authorization reads still precede
admission; execution policy, deduplication, and closure checks use state under the
winning claim.

Reading an immutable descriptor before start is consistent because neither another
turn nor rekey can change its contents. Persisting it in workflow input therefore
preserves the same references on replay. It says where to find state, not what that
state currently contains.

Reading mutable state in ingress is not sufficient, even when no turn is active:

1. Request A reads snapshot revision 7 and observes no active owner.
2. Request B starts a candidate, claims ownership, commits revision 8, and releases.
3. A's delayed candidate successfully claims ownership. Its supplied revision 7
   is stale; a claim establishes exclusion from now on, not since the earlier read.

Only the snapshot stream changed in this example. The immutable resource descriptor
still points to the same snapshot stream.

The required ordering for an ordinary handoff is `previous commit acknowledged ->
previous claim released -> next claim acquired -> latest snapshot read -> effects`.
The storage adapter must make an acknowledged commit visible to that subsequent
reader. A pre-read would need an atomic reservation or validation after the claim;
a timestamp, owner lookup, or revision carried in input does not supply either.
The first version therefore passes resource references and the accepted event,
without a prefetched mutable snapshot. Existing first-event initialization still
uses the designated initial seed.

This proof depends on exclusive writers, durable flush before release, and reads
that observe completed commits. Hard cancellation, delayed writers, and step retries
still require the fencing and reconciliation rules below. Moving a read alone
does not establish those properties.

### Measured boundaries and remaining performance checks

A temporary Local World experiment compared descriptor resolution in ingress with
a preceding discovery step. Both variants claimed ownership and hydrated inside
the execution step. Uncontested candidates recorded:

| Descriptor placement         | Persisted candidate steps | Descriptor plus snapshot stream reads | World queue submissions per candidate |
| ---------------------------- | ------------------------- | ------------------------------------- | ------------------------------------- |
| Separate discovery step      | 2                         | 2                                     | 1                                     |
| Ingress, uncached descriptor | 1                         | 2                                     | 1                                     |
| Ingress, cached descriptor   | 1                         | 1                                     | 1                                     |

Two further cases reproduced the stale-snapshot race and confirmed that conflict
classification skipped hydration: zero execution steps with resolved input versus
one discovery step with locator input. All three cases passed using real hooks and
streams with mock execution. The fixtures used temporary writer handles for the
installed SDK and were removed; forwarding, acknowledgement, finalization, record
references, and fencing were not exercised.

This establishes a saved durable step against a separate discovery step. The SDK
executed steps inline, so it does not establish a saved queue invocation. Stream
counts are World operations, not total network requests. An uncached descriptor
read moved into ingress; it did not disappear. A locator variant that already knows
the session ID could combine discovery with execution and also avoid that boundary.

Measure hosted request receipt through first model work, first client event, and
committed settlement. Include alias lookup, descriptor/cache work, start inputs,
hook claims, reads of specific records and latest snapshots, encryption/run metadata,
checkpoint writes, step results, forwarding, and retries. Count actual requests,
bytes, and serial dependencies as well as steps. Compare cold/warm descriptors,
idle/busy sessions, realistic history sizes, and bootstrap separately. Hosted
latency and cross-deployment consistency remain implementation gates.

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
   with its resulting state and returns the compact `TurnReceipt`. In v1, candidates
   follow the actual owner's run result; the receipt references its checkpoint.
   A hook receipt is never the application acknowledgement.
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

Internal senders receive an `InboxAddress` bound to one `ownerRunId`, or a stable
session destination for traffic that may outlive a turn. The envelope contains
`version`, identity `(producer.id, eventId)`, target, and a discriminated event with
its domain payload. Token `:v1:` identifies the topology; envelope versions evolve
independently. This implementation uses envelope v1. Future turn versions must
retain the v1 session-admission contract while older owners can receive input;
the holder's v1 rekey contract remains frozen for its lifetime.

Direct sends target the addressed owner run, including replies through `replyTo`.
Receivers check that target before applying an event. An old reply delivered to a
successor that reused the turn token is stale, not a reply for the successor.
Session admission instead targets `sessionId`, allowing forwarding candidates to
follow the actual resumed owner. Preserve logical turn, operation, and request
guards inside the payload; changing transport owners does not retarget a cancel
or answer to unrelated work. None of these checks uses hook metadata.

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
Deduplication spans aliases, candidates, and turns for the automatic retry horizon.
Pending correlations and unacknowledged input remain
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

## Delete the old orchestration and rebuild

Treat the current workflow orchestration as a subsystem to replace. Begin the
implementation by identifying its removal boundary and the domain functions worth
retaining. Remove the superseded state machines, transports, and ownership code,
then implement the new contracts directly. Work can be split into reviewable
commits, but the completed implementation must have one session/turn execution
path. A new API over the existing parent loop does not satisfy this design.

Prefer deleting whole modules or directories when their responsibilities are
replaced. When a module mixes useful domain logic with obsolete coordination,
extract the necessary domain functions into their new home and delete the old
module. Do not copy its orchestration into a renamed file or preserve its call
graph through adapters. Compatibility branches, capability flags, parent
acknowledgements, and old token routing must not survive as hidden implementations
of the new interfaces. Future legacy-session migration belongs outside the normal
execution path.

The map below identifies the main removal boundaries, not an exhaustive deletion
list. Follow their callers and dependencies: remove orphaned exports, workflow
registrations, transport types, compatibility helpers, and tests that only assert
the obsolete choreography. Preserve and update tests for externally observable
behavior, delivery guarantees, and failure handling.

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

Assess [`execution/tools/workflow/`](../packages/eve/src/execution/tools/workflow/)
and [`execution/tasks/parent/`](../packages/eve/src/execution/tasks/parent/) as whole
directory replacement candidates. Their useful outcome conversions, task ownership
checks, and state projections can be extracted; their existing transports and
owner/caller wiring do not determine the new structure. Rebuild blocking tools,
background tasks, and input correlation against the new owner inbox and session
admission contracts. Actual task and subagent relationships still require the
behavior specified above. Keeping that behavior does not require keeping these
directories.

Build the replacement as small modules with explicit dependencies:

- `session/resources` owns identities, the immutable descriptor, and directory
  resolution. Channels use it before dispatch and pass only references and input.
- `session/storage` implements `SessionEvents` and `SessionSnapshots` directly over
  the chosen storage primitive. It carries no parent cursor or execution policy.
- `session/holding-workflow` composes resource setup, first dispatch, and the frozen
  rekey contract. It must not import the agent execution loop or snapshot reducers.
- `inbox/owner-inbox` owns hook claims, readers, buffering, and correlation. Domain
  decisions belong to the receiving owner.
- `turn/{workflow,execute,reduce,finalize}` owns admission, execution, settlement,
  and committed state. The first execution step hydrates the snapshot and uses the
  existing harness through eve-owned interfaces.

These boundaries do not require a class or extensibility framework each. Keep SDK
calls in the workflow/storage adapters and reuse ordinary functions for composition
inside steps. An adapter translates an eve contract to SDK primitives; it must not
translate that contract back into the deleted parent/child protocol. Reuse proven
hydration, tool execution, authorization, task state, and event formatting logic
only where it fits the new boundaries without carrying the old coordination along.

Review completion through the resulting dependency graph as well as behavior:
creation reaches the minimal holder; later submissions reach independent turn
candidates; each receiving owner has its own inbox; and execution reads/writes
storage by reference. No normal path reaches the old driver, inline promotion,
completion-token exchanges, or parent-owned persistence. Required cleanup,
supervision, and delivery behavior must be rebuilt in the new owners and pass the
implementation gates; leaving those responsibilities in the old parent is not a
completed implementation.

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
the fact that the holding run is still alive. Session expiry and execution supervision
remain outside the holder's rekey loop. Preserve the existing timeout policy and
durable scheduling; timeout producers use session admission. Disabling session
expiry does not disable failure detection.
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

Start by defining the removal boundary and resolving three implementation questions
with small, bounded experiments against the new contracts:

1. Implement immutable record addressing and choose the commit/fencing mechanism.
   Prove visibility after an acknowledged append, replay of a specific step result, and
   exclusion of a stale writer after hard cancellation. Revision numbers alone
   are not a fence. Include the storage and serialization cost.
2. Choose the durable recovery trigger for a failed holder bootstrap or candidate.
   Prove it runs without new input and with session expiry disabled, preserves the
   accepted event, and cannot duplicate uncertain effects. A waiting candidate
   watching another owner is not supervision of that candidate itself.
3. Close provider bootstrap races, including simultaneous first messages and the
   Slack post-to-rekey interval. Prove that one session executes the input and no
   acknowledged message is stranded in a losing holder.

These mechanisms are required implementation work, not established SDK guarantees.
Then rebuild the target modules and connect every ingress path, using the following
gates to review the completed replacement. Migration remains follow-up work and
does not gate v1:

| Gate                                   | Required evidence                                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestration replacement              | Main removal boundaries identified; useful domain logic extracted; superseded modules/directories and orphaned wiring removed; one session/turn path uses the new interfaces directly, with no legacy orchestration hidden behind adapters.                                     |
| Resource contracts and minimal holder  | Distinct session/run/event/snapshot IDs round-trip; descriptors are immutable/cacheable; first start follows readiness on the accepting deployment; only rekey reaches the holder; duplicate/conflicting/bounded aliases and missing reply recipients preserve existing claims. |
| Durable admission                      | Early follow-ups; duplicate starts after hook release; queue order; late finalization input; actual-owner changes; failed candidates visible without new traffic.                                                                                                               |
| Snapshot and execution safety          | Empty reads return without blocking bootstrap; exact record references replay consistently; proposals remain distinct from settled state; stale writers are fenced; output flush and recovery avoid duplicate effects/outcomes; workflow inputs/results remain small.           |
| Inbox and turn behavior                | Fresh readers/claims on retries; owner-target guards reject stale replies after token reuse; queue/steer/interrupt/cancel precedence at model, tool, sleep, ask, auth, and finalization boundaries; no lost input or premature lifecycle effects.                               |
| Tools, late events, and cleanup        | Blocking tool/background task ownership; concurrent asks and runtime replies; send failure/cancellation cleanup; late events while idle; expiry and terminal cleanup without a new holder command.                                                                              |
| Stream adapter and end-to-end behavior | Writes by ID through the assumed SDK capability, encrypted cross-deployment reads/writes, cursors, event decoding, closure, deterministic fixtures, and paired hosted latency including starts, claims, snapshots, and forwarding.                                              |

Use unit tests for reducers, Workflow-backed scenarios for durable scheduling and
failure boundaries, and CI fixture evals for streaming behavior (`agent-workflow-tools`,
`fixture-tasks`, `agent-channels`). Follow [turn performance](./turn-performance.md)
for paired measurements. Durable input ownership remains mandatory. There is no
hosted performance result for this topology yet.

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
