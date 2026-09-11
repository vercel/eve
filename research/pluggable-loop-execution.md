---
issue: https://github.com/vercel/eve/issues/512
status: proposed
last_updated: "2026-07-20"
---

# Pluggable loop execution

## Decision

eve will run sessions through one shared session program and one shared turn
program over an internal, eve-owned `LoopBackend`. Workflow SDK, a persistent
single-process backend, and a future Temporal backend implement that port; they
do not reimplement session delivery, child routing, cancellation, or agent
semantics.

The shared turn program drives an engine-neutral `AgentKernel`. The kernel
receives a versioned, data-only checkpoint and returns explicit transitions for
continuation, suspension, completion, and failure. Externally observable work
is represented by typed effects with stable operation identities rather than
executed inside a retryable kernel transition.

Channels, routes, schedules, and evals use one host-scoped `Loop` service. It
provides atomic, idempotent delivery; stable session addressing; cancellation;
internal signal capabilities; and event replay. Workflow hooks, run IDs,
streams, directives, private registries, Worlds, and build transforms remain
private to the Workflow backend.

Workflow remains the default production backend. The first extraction does not
add a public backend plugin API or change agent authoring. An inline backend
provides fast conformance tests, and a filesystem-backed Process backend proves
that an agent can run without Workflow artifacts. Temporal remains a later
product and dependency decision.

This plan consolidates the boundary audit in PR #983, the data-contract proposal
in PR #984, and the executable portability evidence in PRs #513 and #700.

## Goals

- Keep one implementation of eve session and turn semantics across backends.
- Remove Workflow types and behavior from neutral channel, kernel, context,
  protocol, and runtime-service modules.
- Make delivery, address ownership, waits, effects, cancellation, and events
  explicit and deterministic.
- Persist versioned eve-owned data without loading executable code while
  decoding it.
- Preserve current task, conversation, HITL, child, and latest-turn behavior
  during the extraction.
- Prove the boundary with Workflow, inline, and Process implementations sharing
  one conformance suite.
- Delete legacy protocols and fake injection points rather than maintaining
  permanent compatibility paths.

## Non-goals

- A public interface for third-party Loop implementations in the first change.
- Shipping Temporal or adding Temporal runtime dependencies.
- Changing a session to pin one immutable agent revision. Revision pinning and
  explicit upgrades require separate product and artifact-retention decisions.
- Guaranteeing exactly-once behavior from external systems that do not honor an
  idempotency key.
- Supporting a horizontally shared Process backend or using it in serverless
  deployments.
- Preserving sessions created by the pre-extraction Workflow protocol across
  the final cutover.

## Boundary model

```text
channels / HTTP / schedules / evals
                 |
                 v
          host-scoped Loop
                 |
                 v
      shared runSession / runTurn
            |             |
            v             v
       AgentKernel    LoopBackend
                    /      |       \
             Workflow   Process   Temporal
              backend    backend   (future)
```

Ownership is fixed:

- `Loop` owns the caller-facing session service.
- `runSession` owns session lifetime, address ownership, admitted-delivery
  ordering, turn dispatch, and terminal settlement.
- `runTurn` owns kernel advances, effect completion, child waits, and turn
  cancellation.
- `AgentKernel` owns conversation history, authored state, compaction,
  model/tool decisions, and semantic wait reasons.
- `LoopBackend` owns persistence, scheduling, backend retries, wakeups, child
  execution, effect receipts, event storage, and implementation lifecycle.
- Host/build adapters own routes, workers, transforms, and deployment artifacts.

Workflow, Process, and Temporal adapters may use different mechanics. They may
not define different delivery, checkpoint, child, cancellation, or terminal
semantics.

## Identity and addressing

The shared contract separates identities that are currently represented by
Workflow run IDs and hook tokens:

```ts
type SessionId = string & { readonly __brand: "SessionId" };
type SessionAddress = string & { readonly __brand: "SessionAddress" };
type SignalCapability = string & { readonly __brand: "SignalCapability" };
type TurnId = string & { readonly __brand: "TurnId" };
type ChildId = string & { readonly __brand: "ChildId" };
type DeliveryId = string & { readonly __brand: "DeliveryId" };
type SignalId = string & { readonly __brand: "SignalId" };
type EventId = string & { readonly __brand: "EventId" };
type EventCursor = string & { readonly __brand: "EventCursor" };
type OperationId = string & { readonly __brand: "OperationId" };
```

- `SessionId` is the stable public identity of one session and is never a
  backend run ID.
- `SessionAddress` is a channel-owned address such as a chat or thread key.
- `SignalCapability` authorizes one framework-owned wait completion. Ordinary
  delivery APIs never accept it.
- Delivery and signal IDs provide caller-visible idempotency and typed
  conflicts. Event and operation IDs provide the same invariant inside the
  execution protocol, where conflicting bytes are fatal backend errors.

At most one live session owns an address. Address ownership lasts through
active turns and parked waits; an implementation may not equate ownership with
the presence of a backend waiter.

Late channel anchoring remains supported. `session.setContinuationToken()` is
projected into a framework-owned address-rebind effect handled by `runSession`.
It is not a public author operation. Rebinding claims the new address before
releasing the old address, fails on conflict, and never exposes an interval
where a delivery may start a second session. A terminal session releases its
addresses; its event log remains readable by `SessionId` until retention
expires.

## Loop service

The host creates one lightweight `Loop` service and injects it into routes,
schedules, callbacks, and local child dispatch. Callers do not construct a
Workflow runtime per request.

```ts
interface Loop {
  accept(command: AcceptCommand): Promise<AcceptResult>;
  signal(capability: SignalCapability, command: SignalCommand): Promise<SignalResult>;
  cancel(command: CancelCommand): Promise<CancelResult>;
  events(
    sessionId: SessionId,
    options?: { readonly after?: EventCursor },
  ): Promise<ReadableStream<StampedAgentEvent>>;
}
```

An accept target is either a stable session ID or a channel address. An omitted
target is valid only for an unconditional start. A `SessionId` target always
uses `onMissing: "reject"`; a missing stable ID never creates a replacement.
`onMissing: "reject"` on an address never creates a replacement, while
`onMissing: { start: seed }` performs atomic address-based deliver-or-start.

```ts
type AcceptCommand = {
  readonly delivery: ExternalDelivery;
  readonly deliveryId: DeliveryId;
  readonly policy?: "queue" | "steer";
} & (
  | { readonly target?: undefined; readonly onMissing: { readonly start: SessionSeed } }
  | { readonly target: { readonly sessionId: SessionId }; readonly onMissing: "reject" }
  | {
      readonly target: { readonly address: SessionAddress };
      readonly onMissing: "reject" | { readonly start: SessionSeed };
    }
);

type AcceptResult =
  | {
      readonly status: "started" | "admitted";
      readonly sessionId: SessionId;
    }
  | { readonly status: "not_found" | "unsupported_policy" | "conflict" };

interface SignalCommand {
  readonly signalId: SignalId;
  readonly payload: SignalPayload;
}

type SignalPayload =
  | { readonly kind: "addressed_input"; readonly input: DurableValue }
  | { readonly kind: "authorization"; readonly outcome: DurableValue }
  | { readonly kind: "runtime_action"; readonly result: DurableValue }
  | { readonly kind: "child"; readonly result: DurableValue }
  | { readonly kind: "effect"; readonly receipt: DurableValue }
  | { readonly kind: "callback"; readonly result: DurableValue };

type SignalResult =
  { readonly status: "accepted" } | { readonly status: "not_found" | "expired" | "conflict" };

interface CancelCommand {
  readonly target: { readonly sessionId: SessionId } | { readonly address: SessionAddress };
  readonly turnId?: TurnId;
}

interface CancelResult {
  readonly status: "accepted" | "no_active_turn";
}

interface StampedAgentEvent {
  readonly id: EventId;
  readonly cursor: EventCursor;
  readonly event: AgentEvent;
}
```

The default policy is `queue`. `accept()` resolves only after the delivery is
durably owned by the session or a new session has been durably created. A
repeated `DeliveryId` returns the original outcome and never applies the
delivery twice. Storage, serialization, transport, and backend failures
propagate; they never fall through to session creation.

Channel authors select the same policy through the API proposed by issue #867:

```ts
type TurnPolicy = "queue" | "steer";

interface SendOptions {
  readonly turnPolicy?: TurnPolicy;
}
```

The option also reaches low-level delivery and Chat SDK surfaces. Built-in
channels remain `queue` unless they explicitly opt into steering. Backend
selection and backend-private capabilities are not exposed to authors.

The session program maintains a monotonic admission ledger. It may lease one
delivery to an active turn, but ownership moves only when the turn commits a
`consumed`, `released`, or `remainder` disposition. Queue order is independent
of acknowledgement timing. Steering follows issue #867: it joins a supported
active conversation turn at a safe boundary or remains queued. Unsupported
task-mode steering returns `unsupported_policy` without consuming the ID.
Successful admission does not promise that steering will eventually apply; a
terminal race may return the delivery to the queue, and the event log records
the final disposition.

`signal()` is reserved for framework-owned capabilities such as authorization,
effect results, child results, and remote callbacks. Capabilities are scoped,
expiring, single-purpose records; signal IDs deduplicate completion. Private
Workflow control hooks do not appear in this union. Unknown and expired
capabilities return typed outcomes; reusing a consumed capability or signal ID
with a different result returns `conflict`.

`cancel()` accepts a session ID or address plus an optional observed turn ID.
An effective cancellation reaches the invocation-local signal, requests
cancellation of active descendants, emits `turn.cancelled` followed by
`session.waiting`, and leaves the conversation session reusable. Already
published events remain visible, while only settled history enters the next
turn. Unknown, idle, parked, settled, and duplicate targets return
`no_active_turn`. A request naming an older turn is an accepted benign no-op so
it cannot cancel newer work. Reader disconnect and host shutdown do not imply
turn cancellation. Backend failures propagate.

## Agent kernel

The kernel has explicit initialization and advancement operations:

```ts
interface AgentKernel {
  initialize(seed: KernelSeed, context: KernelExecutionContext): Promise<KernelTransition>;
  advance(
    checkpoint: KernelCheckpoint,
    input: KernelInput | undefined,
    context: KernelExecutionContext,
  ): Promise<KernelTransition>;
}

type KernelTransition =
  | ActiveTransition<"continue">
  | (ActiveTransition<"suspend"> & { readonly wait: WaitSpec })
  | (Transition<"complete"> & { readonly output: DurableValue; readonly isError?: boolean })
  | (Transition<"fail"> & { readonly error: SerializedError });

interface Transition<TKind extends string> {
  readonly kind: TKind;
  readonly checkpoint: KernelCheckpoint;
  readonly events?: readonly AgentEvent[];
}

interface ActiveTransition<TKind extends string> extends Transition<TKind> {
  readonly effects?: readonly EffectRequest[];
}
```

`WaitSpec` distinguishes ordinary delivery, addressed input, authorization,
runtime action, child, and effect waits. `KernelInput` has matching delivery,
authorization, runtime-action, child-result, effect-result, and cancellation
variants. Completion and failure are explicit transitions. The driver never
infers a wait or outcome by inspecting checkpoint or authored state.

`initialize()` creates the first checkpoint from a data-only seed. Executable
agent, channel, model, tool, connection, and sandbox behavior is resolved by
stable IDs through invocation-local runtime services. A checkpoint decoder
never imports a bundle or executes authored code.

Any operation that can incur external cost or cause an externally observable
side effect is an `EffectRequest`, including model generation, authored tools,
child starts, and remote dispatch. Pure local computation may run inside the
kernel. Effects accompany only nonterminal transitions; the kernel cannot
declare completion while work is outstanding. Terminal callbacks and stream
publication are derived by `runSession` from its stored outcome, never authored
independently by the kernel.

The shared turn program assigns stable `OperationId`s, dispatches effects, and
feeds persisted receipts back as `KernelInput`. A thrown kernel exception is an
infrastructure attempt failure; a returned `fail` transition is a terminal
agent outcome.

Invocation-local cancellation, telemetry, event writers, and runtime services
are not durable values. A backend may carry native live handles inside its own
wrapper, but they do not enter the shared snapshot or cross the public Loop
contract.

## Checkpoints and durable values

Each committed session revision contains one eve-owned snapshot:

```ts
interface SessionSnapshot {
  readonly formatVersion: 1;
  readonly session: SessionMetadata;
  readonly program: {
    readonly agentId: string;
    readonly nodeId: string;
    readonly contractVersion: number;
  };
  readonly channel: { readonly id: string; readonly state: DurableValue };
  readonly kernel: KernelCheckpoint;
}
```

The kernel owns `KernelCheckpoint` schema migrations. The backend treats the
checkpoint as opaque data. Backend-private attempt, wait, lease, address,
effect, and event records are not inserted into authored state.

A child turn borrows a versioned checkpoint lease. The parent persists each
monotonic child revision before acknowledging it; exact redelivery is
re-acknowledged, while the same revision with different bytes conflicts. The
child cannot mutate parent-owned session identity or write after returning the
lease. Its terminal checkpoint must match the last acknowledged revision, and
the lease returns before its handle settles.

`DurableValue` is an eve-owned tagged value model covering JSON values and the
explicit rich values eve supports. Every durable command, transition,
checkpoint, effect input, receipt, and terminal output is validated before
commit. Unsupported values fail with an eve-owned serialization error. Backend
serializers may encode the value model but may not expand it implicitly.

Current revision behavior is preserved: the session program remains pinned to
the build that started it, while each new turn resolves the latest compatible
agent program and retains that revision through replay and completion. Workflow
keeps its current latest routing and pinned fallback; Process retains the
selected catalog artifact until the turn settles. No adapter may invent an
additional fallback for unavailable or incompatible revisions. Artifact
retention, immutable session pinning, explicit upgrades, and garbage collection
are a separate product decision.

## Effects, events, and terminal publication

Each effect definition centrally owns its stable `OperationId` derivation and
declares `idempotency: "required" | "none"`; adapters may not choose different
policies. Before dispatch, the backend persists the ID, kind, canonical input
bytes, and policy. Reusing an ID with different bytes is a protocol error.

The backend persists immutable success, declared-failure, exhaustion, and
indeterminate receipts. Exact replay returns the stored receipt. A `required`
effect may retry only through an integration that reconciles or returns the
same result under `OperationId`. A `none` effect gets one possibly-visible
dispatch attempt; a crash after dispatch begins but before receipt commit
becomes `indeterminate` and is never blindly retried. Models, authored tools,
child starts, remote requests, and callbacks all use this protocol. The public
contract does not claim exactly-once behavior from an external system that
does not honor the operation identity.

The event log is append-only and authoritative for public streaming:

- Appending the same `EventId` and canonical bytes returns the original cursor;
  reusing the ID with different bytes is a protocol error.
- Opaque cursors are assigned atomically and ordered within one session.
- Reading `after` a cursor is exclusive and deterministic.
- Terminal events remain replayable through the retention window.
- Retrying a kernel transition or effect cannot duplicate an event.
- Streaming effect events use the effect operation ID plus a stable ordinal, so
  replay can deduplicate already-visible output.
- Public events and health responses do not expose Workflow run IDs.

Public stream clients reconnect with the last observed opaque cursor. The
existing numeric `startIndex` API is removed at cutover rather than interpreted
differently by each backend; initial reads omit `after`, and tail helpers remain
facade behavior over the eve-owned event store. Workflow streams and HTTP
delivery are at-least-once projections of this canonical log.

A logical backend commit records the next snapshot, admission dispositions,
address changes, wait state, effect intents, and transition events. When a
session reaches a terminal state, `runSession` alone commits its final
checkpoint, one immutable outcome, terminal event, address disposition, and
callback or stream outbox entries. Backend results and publications derive
from that outcome. Projection failure cannot roll back terminality or
substitute another result; retries repair the outbox with event and operation
deduplication.

## LoopBackend and implementations

`LoopBackend` is an internal, closed eve port. Its eve-owned subcontracts cover:

- atomic session snapshot and admission-ledger commits;
- durable waits and wakeups;
- effect execution and receipt lookup;
- session and turn child handles;
- event append and cursor reads;
- cancellation and descendant cleanup;
- lifecycle startup and shutdown.

Adapters expose these capabilities without leaking steps, hooks, Activities,
Signals, streams, run IDs, or third-party errors into shared programs.

### Workflow backend

Workflow remains the default. This backend owns SDK imports, directives, hooks,
run lookup, workflow streams, attributes, Worlds, deployment routing, private
dynamic-tool registration, transforms, and bundle generation.

The existing `experimental.workflow.world` authoring option remains supported
during extraction for local, Vercel, and custom Worlds. The adapter preserves
the current pinned session-driver/latest-turn behavior. Backend-native live
signals and streams are constructed inside its workflow or step wrappers.
Hooks are wakeups after durable receiver-ledger acceptance, not proof of
acceptance themselves; a missing Hook on retry is successful only when that
ledger confirms the exact `SignalId` and bytes. Child starts use a stable
`ChildId` and persisted child-to-run mapping so response loss cannot orphan a
duplicate Workflow run.

### Inline backend

The inline backend is a deliberately non-durable reference interpreter. It
runs the shared programs directly, stores state and events in memory, performs
no automatic retry, and loses parked sessions when closed. It is used for unit
tests and semantic debugging, not advertised as durable execution.

### Process backend

The Process backend is a persistent, single-host implementation for local
development and self-hosted evaluation. It uses a filesystem-backed store,
holds an exclusive host lock, resumes parked sessions after restart, and
replays from the last committed transition using effect receipts and event
IDs. It rejects unsupported multi-process or serverless deployment rather than
silently weakening ownership guarantees.

It must implement root and child sessions, callbacks, waits, cancellation,
event replay, and shutdown without invoking the Workflow backend or generating
Workflow artifacts. Shutdown stops new admission and aborts invocation-local
work without semantically cancelling sessions; restart resumes durable work
from the last committed transition.

### Temporal

PR #700 establishes feasibility against the prototype contract. Production
Temporal work starts only after Workflow and Process pass the production
conformance suite and eve has explicit decisions for Worker hosting, event
storage, revision routing, codecs, and dependency packaging.

## Runtime and build selection

Runtime lifecycle and build contribution are separate internal interfaces. A
host selects a `LoopBackendFactory`; a matching build adapter contributes only
the routes, workers, transforms, and deployment artifacts required by that
backend.

The first extraction keeps backend selection internal. Workflow remains the
normal product default, tests inject inline, and a dedicated self-hosted
fixture selects Process. Public host-level selection can be designed after the
Process proof; it does not belong on `AgentDefinition` because backend choice
is deployment behavior, not agent behavior.

## Migration

1. **Safe subtraction.** Delete unreachable legacy driver arms, the old stream
   snapshot fallback, inert runtime-factory options, and duplicated park-store
   helpers. Land naming and dependency-direction cleanup separately where it
   does not change behavior.
2. **Identity and admission.** Introduce stable session/address/capability IDs,
   atomic accept, typed error outcomes, the admission ledger, and address
   rebind semantics over the existing Workflow implementation. Fix issue #982
   independently if the narrow correctness change is ready sooner.
3. **Kernel and shared programs.** Add durable values, kernel initialization and
   transitions, effect identities, and shared session/turn programs. Adapt the
   current Workflow path without changing task, conversation, HITL, child, or
   latest-turn behavior.
4. **Workflow quarantine.** Move SDK runtime and build mechanics under the
   Workflow backend. Add a structural invariant rejecting Workflow imports,
   directives, private symbols, and implementation imports in neutral modules.
5. **Second implementations.** Land inline and Process against the same
   conformance suite. A Process deployment must build and run without Workflow
   artifacts.
6. **Cutover and deletion.** Switch all routes, schedules, callbacks, children,
   cancellation, and event reads to the host-scoped Loop, then delete the old
   Runtime and driver protocols in the same release.

The cutover does not retain a permanent legacy reader. Sessions created by the
old protocol may fail to resume after that release; release notes and the
breaking pre-1.0 changeset must say so. Public cursor and backend-ID removals
land with the same documentation and compatibility tests.

## Conformance and verification

The same parameterized suite runs against Workflow, inline, and Process, with
durability-only cases skipped solely for inline. It covers:

- concurrent accept, unconditional start, deliver-or-start, address conflict,
  response loss, and unexpected backend failure without fallback creation;
- duplicate and conflicting delivery and signal IDs;
- whole-turn address ownership and claim-before-release rebind;
- queue and steer ordering, lease disposition, terminal races, and task-mode
  rejection;
- initialization, continuation, every wait kind, completion, and terminal
  failure;
- input, authorization, local children, proxied HITL, remote callbacks, and
  descendant cancellation;
- model and tool receipt reuse after ambiguous completion, callback retry, and
  child-start deduplication;
- event ordering, reconnect, cursor replay, retry deduplication, and terminal
  retention;
- crash injection before and after effect-intent commit, external completion,
  receipt commit, and caller response, including typed `indeterminate` outcomes;
- crash injection between event append, checkpoint commit, acknowledgement,
  child start, handle return, terminal commit, projection, and outbox repair;
- exact private-signal replay through receiver ledgers, including conflicting
  bytes and missing Workflow Hooks;
- Process restart, host locking, resource disposal, and unsupported topology;
- latest-turn revision resolution and cross-version durable codecs;
- conversation and task-mode terminal semantics.

Workflow-specific integration and hosted E2E coverage remain mandatory for
serialization, replay, hook ownership, build transforms, deployment skew,
native stream mirroring, and fixture boot. Process replaces Workflow only in
tests whose assertion is backend-neutral.

PR #513's prototype suite remains evidence for shared programs, effect
identity, approval buffering, child handles, and conversation park/resume. Its
unproved production gates—delivery/rekey races, terminal publication, codec
adoption, real effect idempotency, Workflow child-start idempotency,
cancellation, host selection, crash recovery, and private-control deduplication—
are required before the final cutover.

## Acceptance criteria

The extraction is complete when:

- Workflow and Process run the same session, turn, and kernel programs.
- Channels, callbacks, schedules, and children depend only on `Loop`.
- Neutral modules contain no Workflow type, import, directive, private symbol,
  run ID, stream primitive, or deployment selector.
- Delivery is atomic, durably admitted, idempotent, and correctly ordered
  through active-turn and address-rebind races.
- Every durable command, transition, checkpoint, effect, receipt, and terminal
  result validates as an eve-owned durable value.
- External effects, child starts, events, and terminal publication have stable
  operation identities and tested ambiguous-failure behavior.
- Workflow and Process produce identical normalized results across the shared
  conformance and eval corpus, with backend-specific restart and cancellation
  coverage.
- A Process deployment generates and loads no Workflow artifacts.
- Current latest-turn and Workflow World behavior remains documented and
  covered.
- Old compatibility protocols and fake seams are deleted rather than expanded.
