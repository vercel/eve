---
issue: https://github.com/vercel/eve/issues/876
status: proposed
last_updated: "2026-09-04"
---

# One logical inbox per durable owner

eve should give each receiving workflow one logical inbox: a set of hooks that
accept the same discriminated event protocol and feed one buffer and reducer.
Each hook reserves an address through which that owner can receive messages.
Every session starts with its stable session-ID hook, then adds external
addresses when they become known. Senders resume the addressed hook directly.
New owner-inbox hooks omit `HookOptions.metadata`. Existing sessions keep their
protocol and addresses through a compatibility path; upgrading eve must not
require resetting a live session.

This refactor addresses these connected problems:

- Inline turns currently delegate tool coordination to another turn workflow,
  adding a start, claims, and message relays on the same deployment.
- Separate hooks for cancellation, reports, and replies give message kinds
  their own durable cursors and lifecycle paths. Those belong in the protocol;
  additional hooks are needed only to reserve additional addresses.
- Current `steer` behavior aborts and replaces the turn. True steering needs
  input to arrive during a step and join the same turn at its next boundary.
- The harness can publish `turn.completed` before the workflow inspects newly
  arrived input. The owner must decide whether to continue before finalizing.

The expected gains are fewer durable operations and consistent input and
settlement semantics. Hosted latency remains a measured outcome: hook counts
alone do not establish a fix for [#876](https://github.com/vercel/eve/issues/876).
Use the paired benchmarks in [turn performance](./turn-performance.md).

The background pump merges the hook iterators while foreground work runs.
The design assumes this is Workflow-safe; a small spike will verify dynamic
registration, merged ordering, replay, cancellation, and disposal.

## Review and release boundary

The ownership model is worth pursuing. The current
[inline loop](../packages/eve/src/execution/inline-turn.ts) promotes sleep,
background-task admission, cancellation, and tool coordination to a child.
Keeping those operations inline removes an execution boundary and its relays.
Correlating requests in one owner inbox also removes per-request hook lifetimes.
The existing session inbox already multiplexes readers, so multiplexing alone
is not the architectural gain.

The proposal is not implementation-ready. Its release blockers are replay-safe
pumping, recoverable settlement, and coexistence with persisted old workflows.
It also adds costs: owner finalization, supervision, buffered input, and retained
addresses. Long session histories still grow. Measure ordinary inline turns as
well as tool-heavy turns; reduced hook counts cannot justify a latency regression.

The first release preserves existing session IDs, streams, conversation claims,
queued input, and pending work. Existing sessions may keep old execution and
steering semantics and may need to stay on old code. New sessions get the new
topology. An automatic reset, a silently forked provider thread, or an old parent
whose next child cannot start is not an acceptable upgrade. This compatibility
requirement applies to persisted work even where pre-1.0 authoring APIs change.

## Before and after

A **logical inbox** owns the hook readers, shared buffer, correlations, and
reducer. A **hook** reserves one address and has one reader in that inbox.
Workflow routes a hook token to its owning run; that run then interprets the
event's discriminator and correlation IDs. Add a hook only to address another
independently running owner or reserve another address for the same owner.
Cancellation, reports, requests, replies, and individual operations use event
fields in the existing inbox. There are no lookup-only hooks.

`A` below is one optional authorization callback hook, added when needed.
Counts describe new owners and exclude application-authored hooks, webhooks,
and retained legacy owners.

| Owner                                                  | Current hooks                                                                  | Proposed hooks                                                         | Hook count                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------- |
| HTTP session without a continuation address            | Stable inbox and gated authorization hook                                      | Stable hook; optional callback hook in the same inbox                  | 2 → 1 + A                  |
| Slack session with a known thread                      | Stable inbox, replaceable continuation hook, and gated authorization hook      | Stable and thread hooks; optional callback hook, all in the same inbox | 3 → 2 + A                  |
| Threadless scheduled Slack session                     | Stable inbox, temporary continuation hook, and gated authorization hook        | Stable hook first; add the thread hook after posting                   | 3 → 1 + A, then 2 + A      |
| Turn promoted solely for tools, tasks, or coordination | Six child-turn control and communication hooks                                 | Session owns the turn through its existing inbox                       | 6 → 0                      |
| Additional turn on another accepted deployment         | Inbox, cancellation, parent control, and workflow report/request/outcome hooks | Turn hook; reports and settlement return to the parent's inbox         | 6 → 1                      |
| Additional workflow-tool run                           | Control inbox, plus a hook per answer or agent reply                           | Workflow-tool hook with request-ID correlations                        | 1 + answer/reply hooks → 1 |
| Background task                                        | Command inbox, workflow report/request/outcome hooks, and answer/reply hooks   | Task hook; same-owner body results return in memory                    | 4 + answer/reply hooks → 1 |
| Activity collector                                     | Batch hook                                                                     | Collector hook                                                         | 1 → 1                      |
| Session timeout                                        | Sends to the session inbox                                                     | Sends to the stable session hook                                       | 0 → 0                      |

A session with `C` distinct external addresses owns `1 + C + A` hooks, all
feeding the same inbox. Previously reserved addresses remain active until the
session ends. Session IDs remain Workflow run IDs.

Same-deployment turns stay inline, including workflow-tool dispatch, sleep,
background-task admission, coordination, and cancellation. The session owns the
turn and handles its traffic through the session inbox. These operations must
not promote the turn to another workflow.

A delegated turn is needed when an accepted turn must execute on a different
deployment from the pinned session. Both turn owners use the same execution
loop, pump, reducer, and tool/task coordination. Tool/task body placement follows
[subagent execution boundaries](./executor-neutral-core.md); this plan extends
its active-turn ownership to inline session execution.

For an otherwise inline turn with one blocking workflow tool, additional hooks
fall from `7 + answer/reply hooks` to `1`. This also removes the extra turn start,
ownership claims, input forwarding, and settlement exchange.

### Proposed hook inventory

| Address                | Token                                       | Why this hook exists                                                                                   | Ownership claim              |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Stable session         | `eve:session-inbox:v1:<runId>`              | Addresses the session by ID and receives inline-turn traffic                                           | None; unique to the run      |
| External conversation  | Existing channel-derived continuation token | Preserves one conversation claim namespace across old and new deployments                              | Once per distinct address    |
| Authorization callback | `eve:auth-callback:v1:<random-capability>`  | Gives the session an unguessable callback address; connections and attempts remain event fields        | None; random, session-scoped |
| Delegated turn         | `eve:turn-inbox:v1:<turnId>`                | Wakes the turn executing on another deployment; a session-inbox event wakes only the session           | Before owner work            |
| Workflow-tool run      | `eve:workflow-tool-inbox:v1:<operationId>`  | Addresses an independent blocking tool execution with its own body, cancellation scope, and settlement | Before owner work            |
| Background task        | `eve:task-inbox:v1:<taskId>`                | Addresses admitted work whose execution and input requests can outlive the initiating turn             | Before owner work            |
| Activity collector     | Existing random callback capability         | Addresses the separate activity reducer with its own debounce and expiry                               | Before owner work            |

Every hook above is iterated, server-only (`isWebhook: false`), and created
without `metadata`. The session creates and owns all of its address hooks,
including addresses discovered while a child turn is running.

Independent owners retain `start()` plus `getConflict()`: each candidate creates
its inbox and reader before claiming; only the winner executes the body. Losers
dispose their inboxes and exit without publishing an outcome. A child turn drops
from two sequential claims to one. Start retries use the same logical token.
An ownership claim only excludes simultaneous execution. A retry after the
winner releases its token can execute the body again. Before shipping, prove
that starts converge on the same logical operation through their entire retry
horizon, using a durable start identity or a retained completion record. A live
hook conflict alone is insufficient. Include any retained hooks in the inventory
and benchmarks; do not hide that cost in the deduplication claim.

The installed Workflow SDK documents `experimental_minRetention` for retaining
a claimed token after completion. Evaluate that existing primitive first for
operation inboxes. Its clock starts at hook creation, not completion; a long run
can exhaust it before finishing. Explicit disposal defeats retention, and World
support and limits vary. Prove coverage of the retry horizon instead of choosing
a fixed duration by intuition. Retained hooks are discoverable but cannot receive
messages after the run ends, so completed-owner detection must precede forwarding.
Do not apply operation retention to reusable conversation addresses blindly.

## Routing and event contract

```text
session-ID request -> resume stable hook ------+
                                              |
provider event ----> resume conversation hook -+-> merged readers
                                              |        |
auth callback -----> resume callback hook -----+   background pump
                                                       |
                                                shared session buffer
                                                       |
                                                  session owner
```

All session hooks feed the same event protocol after decoding, including the
temporary legacy conversation decoder below. Tool traffic returns directly to
the workflow that owns the turn:

```text
Same deployment: session owns the inline turn

  session inbox <---- reports / requests / outcome ---- tool inbox
  session owner ----- replies / cancel --------------> tool run

Different accepted deployment: child owns the turn

  session inbox <---------- turn.settled ----------- turn inbox
  session owner -------- input / cancel ----------> turn owner
                                                       ^
                                                       |
                                  reports / requests / outcome
                                                       |
                                                   tool inbox
  turn owner ------------ replies / cancel -------> tool run

Background work, in either case

  session inbox <------- task updates / requests ---- task inbox
  session owner -------- replies / cancel ----------> task run
                                                     owns body
```

The inline turn adds no inbox: its tool run uses the existing session inbox as
its return address. A delegated turn supplies its own inbox to blocking tools.
Background tasks use the stable session address because they can outlive that
turn. Same-run body results and reports enter the owner's reducer directly.

After existing authorization checks, new stable-session and callback ingress
derive their namespaced tokens and call `resumeHook(token, envelope)` directly.
Provider ingress keeps the existing continuation token during coexistence. It
resolves that exact hook, selects its owner's protocol, and resumes the inspected
hook object. It never translates the address into a different stable hook.
Identify new owners by their immutable, topology-specific workflow entry ID;
verify whether the hook's resume context supplies it, otherwise read the owning
run. Legacy owners retain the current metadata/markerless classification. This
costs discovery on the provider path but does not add metadata to new hooks.

Changing a provider key and changing the inbox protocol are separate migrations.
For example, Slack currently derives a channel-name/channel/thread key; adding
installation scope at the same time would bypass the existing claim. Keep the
shipped derivation for existing bindings in this release, retain authorization
and provider-identity checks, and address broader provider scoping separately.

Internal senders receive an `InboxAddress` containing a token and
`protocol: { family: "eve-inbox", version: N }` in durable input or
framework-owned state. That version selects the exact envelope to encode.
New external ingress emits version 1 to new owners. Versioned tokens and the
workflow entry ID identify topology independently of later envelope versions;
the shared conversation token intentionally does not identify topology.

During coexistence, a new owner's conversation reader also needs a narrow legacy
decoder: an old ingress or losing old startup can resume that shared token
without knowing the new protocol. Normalize those historic shapes before the
common reducer. This is the exception to identical wire acceptance across an
owner's hooks. Preserve the historical delivery guarantee when old messages lack
event identities; do not claim new cross-address deduplication for them.

An envelope carries `version`, an event identity `(producer.id, eventId)`, a
target, and a discriminated event with its existing domain payload:

| Event                                                                  | Recipient                              | Target or correlation                                                    |
| ---------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `message` (`queue`, `steer`, or `interrupt`)                           | Session, turn, task                    | Session, active turn, or task                                            |
| `owner.cancel`                                                         | Session, turn, workflow-tool run, task | Owner or active turn                                                     |
| `session.clear`, `session.compact`, `session.reset`, `session.timeout` | Session                                | Session                                                                  |
| `input.response`                                                       | Session, turn, workflow-tool run, task | Request ID                                                               |
| `authorization.response`                                               | Session, turn, task                    | Connection and authorization attempt                                     |
| `runtime.result`                                                       | Session, turn, workflow-tool run, task | Invocation request ID                                                    |
| `workflow.report`, `workflow.request`, `workflow.outcome`              | Session, turn, task                    | Operation/request identity                                               |
| `activity.batch`                                                       | Activity collector                     | Batch identity                                                           |
| `turn.settled`                                                         | Session                                | Turn ID, child inbox/run, finalized state/result, and applied event keys |

The wire contract preserves these invariants:

- Framework encoders own identity, target, and capability fields; client and
  provider payloads cannot override them. The session owner binds session-scoped
  input to the active turn. Mixed user content and answers become separate
  ordered events, preserving both.
- Retries and forwarding preserve event identity. Durable sends derive IDs from
  the step and a logical send key, never the attempt. Provider deliveries use
  namespaced delivery IDs; HTTP ingress mints an ID before retryable work. A new
  HTTP request is a new submission, with no new public idempotency-key API.
- Deduplication covers automatic retry horizons. Unacknowledged forwards and
  pending correlations stay protected. Deduplication is shared across all hooks,
  so a retry through another address cannot apply twice. Address count, buffers,
  bytes, waiters, and deduplication state have explicit bounds; overflow fails
  visibly instead of evicting input or releasing an earlier address.
  Exact capacities and retention follow the spike and retry-contract review.
- Invalid versions, kinds, or owner/target combinations fail visibly. Valid but
  stale events follow their domain rules. Schemas remain append-only, with
  server/step-safe encoders and dependency-free workflow decoders, following
  [the wire-schema plan](./session-inbox-wire-schema.md).

Reject an invalid event with a durable diagnostic while keeping the session
usable. Storage/reader failure is an owner failure, not a malformed-event case.
Successful resume means durable enqueueing, not application or admission by the
reducer. An in-memory buffer limit cannot bound the persisted hook backlog;
ingress admission, byte limits, and bounded drain batches must cover that too.
Overflow after enqueue needs an observable rejection/recovery outcome. Control
and settlement traffic must remain serviceable under a message flood.

## Background pump and turn decisions

One background pump merges the owner's hook iterators while the foreground
awaits a model/tool step, sleep, claim, or authored workflow body. Every event
passes through the same decoder, deduplication, and buffer. The pump wakes
matching waiters and signals the active abort scope; the foreground reducer
owns state changes and lifecycle decisions.

The current session inbox already multiplexes readers. This generalizes that
pattern across owners and moves source-specific behavior into the event protocol.

The [async iterator merge pattern](https://int.pub/posts/iterables#asynchronous)
illustrates concurrent reads, but its fixed input list needs dynamic registration
for this use. Adding a hook must wake the merge and attach its reader without
waiting for an existing hook to receive a message. Registration of the same
address by its owner is idempotent.

Preserve each hook's persisted order and make the merged order reproducible
under Workflow replay. Separate hooks do not imply a global arrival order.
The spike must verify cross-hook ordering relative to foreground step settlement;
wall-clock promise completion alone is not the contract.
If replay does not preserve this decision, persist the decision/cut through a
supported Workflow primitive or narrow the design. Do not add a best-effort
ordering heuristic and call it durable. Bound each drain so a continuously busy
inbox cannot prevent a ready foreground step from making progress.

```text
hooks -> merged reads -> background pump -> decode / deduplicate
                                                         |
                                                   shared buffer
                                                         |
                      +----------------------------------+
                      |                                  |
            matching cancel/interrupt                    |
                      |                                  v
                 abort scope                  foreground boundary reducer
                                              (before/after step or wait)
                                                         |
             +-------------------------------------------+
             |
             +-- cancel ----> finalize cancellation
             +-- interrupt -> finalize interruption -> replacement turn
             +-- otherwise -> adopt result
                                  |
                                  +-- eligible steer -> same turn, next input
                                  |                     after required work
                                  +-- continue/wait --> required work
                                  +-- settled --------> owner finalizer
```

| Input during an active turn      | Active step               | Boundary behavior                                                                                       |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `queue`                          | Continues                 | Adopt the result; retain input for a later turn.                                                        |
| `steer`                          | Continues                 | Adopt the result; inject input at the next eligible boundary under the same turn ID.                    |
| `interrupt`                      | Receives an abort request | Discard uncommitted model output; emit `turn.interrupted`; start replacement input under a new turn ID. |
| Cancel targeting the active turn | Receives an abort request | Discard uncommitted model output; retain the existing cancellation lifecycle.                           |

`DEFAULT_TURN_POLICY` remains `steer`, with the new step-boundary meaning.
Callers requiring abort-and-replace select `interrupt`. At each boundary,
matching cancellation wins over interruption; otherwise the first interrupt
supplies replacement input and later input remains queued. Eligible steers
coalesce in inbox order and prevent natural completion.

Steering preserves required sleep, task dispatch, authorization, human-input,
and runtime-result obligations. Pure answers never steer or interrupt. Stale
cancels are discarded, stale messages become queued input, and responses settle
only matching live requests. Clear/compact remain queued session operations;
reset aborts the active scope and applies existing reset semantics.

One abort scope spans a turn or authored body, including inter-step waits. New
scopes inspect buffered controls before starting work and accept only matching
targets; a stale cancel cannot affect a later turn. Abort is cooperative:
streamed text and completed tool effects cannot be undone. Accepted user input,
admitted tasks, usage, and existing cancellation-state carve-outs survive.
Ordinary turn cancellation preserves admitted tasks; `cancel({ tasks: true })`
also cancels session-owned tasks, including while the session is parked.

Pump failure must abort active work and wake all waiters as an owner failure.
Disposal releases waiters without requiring another inbound message and occurs
after terminal state and pending-event ownership are accounted for. Finishing an
inline turn leaves the session inbox open.

### Finalize after the inbox decision

For eve-managed turns, the harness returns a settlement proposal with its turn
ID and emission state still open. Progress streams immediately. Terminal result,
turn/session events, and their adapter, memory, dynamic-definition, and lifecycle
effects wait for the owner's boundary decision.

The active owner runs a shared finalizer in the `eve` package: the session for an
inline turn, or the claiming child for a delegated turn. Finalization runs on the
turn's deployment, preserving its authored behavior. A child reports the resulting
state, including lifecycle-induced changes, for the parent to adopt without
emitting the lifecycle again.

Scheduling the durable finalization step with immutable input fixes the
decision. A steer accepted by that owner before the decision continues the
turn; later input belongs to a subsequent turn. For child turns, enqueueing at
the parent alone does not establish that the child accepted the steer in time.

Interruption emits `turn.interrupted` with the existing turn-boundary
`sequence` and `turnId`, followed by the replacement's `turn.started`, without
an intermediate `session.waiting`. Cancellation retains `turn.cancelled` then
`session.waiting`. Finalization preserves logical event IDs and timestamps across
retries, along with usage and structured-result semantics. Retried stream writes
may redeliver those IDs. External effects retain their idempotency requirements.

## Address reservation and child accounting

An HTTP-created or threadless scheduled session starts with its stable hook.
A session started by a Slack message also claims the known conversation hook
before executing the turn. On a startup conflict, the losing candidate forwards
initial and buffered input directly to the winning address, preserving event
identities, then closes its own hooks and exits.

Scheduled Slack sessions reserve their conversation address after the first
post supplies a thread timestamp:

```text
start scheduled session     hooks = [stable(sessionId)]
          |
          v
post first Slack message -> receive threadTs
          |
          v
session claims thread hook  hooks = [stable(sessionId), slack(threadTs)]
          |                         |                      |
          |                         +--> same inbox <------+
          v
later Slack replies resume the thread hook directly
```

Continuation registration becomes additive. A new address joins the running
inbox after its claim succeeds; earlier addresses keep their readers and remain
resumable. A mid-session claim conflict fails that reservation visibly and keeps
existing addresses intact. It never merges two running sessions. This includes
a competing start between the first Slack post and its address reservation.

This leaves a real scheduled-post race: replies can establish another owner
before registration. The losing scheduled session must surface which reservation
failed and stop treating that thread as its reply route. Neither repeat the
original post nor silently claim that replies reach it. If seamless scheduled
anchoring is a release requirement, it needs a separate reservation mechanism;
the additive-inbox model does not solve it.

The session owns reservations even when a child discovers the address. The child
requests registration through the parent inbox and awaits the result through
its own inbox, using the shared request/result protocol. No hook is created in
the child to stand in for a session address. Registration visibility and bounded
startup retries remain part of the Workflow spike.

Interactive authorization uses one cryptographically random, session-scoped
callback capability with at least 128 bits of entropy. It is created before
exposing a challenge URL and adds one hook to the same inbox. The callback route
accepts bounded authorization parameters and resumes that hook directly with a
version-one `authorization.response`; it cannot select arbitrary tokens or kinds.
The shared reducer matches the pending connection and attempt, and the connection
strategy validates provider state. Capabilities and secrets stay out of logs.
Session closure disposes every reserved hook and releases all readers.

### Handoff, forwarding, and settlement

```text
session owner                             child turn owner
     |                                          |
     |-- durable start input ------------------>|
     |   accepted deployment + state + input    |-- create inbox + claim
     |                                          |-- execute / adopt handoff
     |-- later event, retaining a copy -------->|
     |                                          |-- reduce + finalize
     |<-- turn.settled -------------------------|
     |    state/result + applied event keys     |
     |                                          |
     +-- adopt state; release acknowledged copies
     +-- queue unapplied messages; retire stale controls/responses
```

Delegation carries session and emission state, pending obligations, selected
input, unapplied events, and both addresses. Any completed work is preserved;
the child must not re-execute it or reinject applied input. The parent retains
transferred events until settlement accounts for them. Tool/task dispatch within
the inline turn needs no handoff or `turn.settled` exchange.

Successful forwarding proves enqueueing, not application. `turn.settled` identifies
the expected turn and inbox, the reporting run, and every applied event key;
acknowledgement means incorporation into returned state or conclusive retirement
by the reducer. Closing the child's admission fixes that set. Late/unapplied
messages remain the parent's responsibility. Resume retries preserve identity;
missing-inbox retries cover only bounded startup registration.

Settlement must not overwrite changes the parent made while the child ran.
The parent owns address reservations, its inbox, and session-level task updates
and cancellations. The child owns its turn result. Define an explicit merge or
versioned projection for those fields; blindly adopting the child's full starting
snapshot plus turn edits can resurrect cancelled tasks or erase a new address.
Bound settlement acknowledgements by outstanding transferred events, not every
event the session has ever seen.

Every owner awaiting a child outcome has durable supervision, independent of
session expiry or new user traffic. A shared Workflow sleep and bounded status
reads detect terminal children with missing reports, allowing a reconciliation
interval for delayed settlement. Supervision follows the inbox's owning run,
which may differ from the candidate returned by `start()`.

A missing report first triggers retrieval of the child's committed settlement.
The finalizer must leave an authoritative, recoverable result with the same
identity as its report; returning the settlement as the Workflow result is a
candidate, but the finalize/report/return crash windows must be tested. A status
of `completed` alone does not contain enough information to adopt state. A late
report and a recovered result must converge on one adoption and one outcome.

If settlement cannot be recovered, surface an explicit unresolved turn while
retaining committed state and input. Keep history, diagnostics, and recovery
controls reachable. Do not replay uncertain tool effects, silently start a
replacement, or emit a second terminal outcome. Status-read outages are not proof
of child failure; a healthy active child remains running. This also applies to
tool/task children and remains active when `sessionTimeoutMs: false` disables
session expiry. A log followed by an indefinitely parked session is insufficient
recovery behavior; the retrieval/repair path is a release gate.

## Workflow-tool and task behavior

The active turn owner dispatches blocking workflow tools and services their
reports, requests, and outcomes through its existing inbox. This is the session
for an inline turn and the child for a delegated turn. Both paths support asks,
runtime calls, cancellation, and supervision through the same handlers.

A blocking workflow tool keeps one separate execution run and inbox for its
authored body's lifetime. Background execution runs directly in the task owner;
it adds no workflow-tool run. The run boundary supplies independent execution
and cancellation; the inbox's discriminated events supply communication. Neither
a new message kind nor a new request ID creates another hook.

`ask()` returns an eve-owned `Promise<ToolInputResponse>` backed by a request-ID
correlation in the requesting tool/task inbox. Awaiting, concurrent asks, and
racing with Workflow `sleep` remain supported. Hook-specific token, iterator,
claim, and disposal members are removed from this API.

Request sends are tracked: send failure rejects the ask. Early replies remain
buffered, answers are single-use, and concurrent asks cannot consume one
another's replies. Winning a sleep race does not withdraw the ask; it remains
answerable until answered or the authored body ends. Body settlement withdraws
remaining requests and cleans up waiters. Cancellation retains the existing
30-second grace period for authored code that ignores its abort signal.

Agent replies become `runtime.result` events in the requesting owner's inbox.
Activity collectors retain their existing debounce and expiry behavior.
Application-authored `createHook` and `createWebhook` remain unchanged.

## Deployment cut

`owner-inbox-v1` is a new execution topology for new owners. It is not a reset of
existing sessions. Ship its tokens, entry IDs, envelopes, callback routing, and
terminal emission together, alongside the compatibility behavior below.

### Four independent upgrade contracts

| Contract                        | What changes                                                                   | Upgrade rule                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox envelope                  | Messages crossing a live hook                                                  | Encode for the receiver; retain frozen historic decoders. A payload migration does not replace the receiver's workflow.                                                      |
| Workflow topology/replay        | Entry/step identities, hook cursors, control flow                              | Existing runs keep a compatible executable graph. Introduce distinct entry IDs for new topology; never replay old history through the new loop merely because inputs decode. |
| Turn input and returned state   | Snapshot, serialized context, pending operations, result, emission state       | Check both directions before delegation. A new child must produce a result and state the pinned parent can adopt without losing meaning.                                     |
| Authored agent code and clients | Instructions, tools, workflows, connections, lifecycle handlers, stream events | Select code at a safe turn boundary; running work stays on its selected deployment. Wire compatibility alone does not make removed tools or changed authored workflows safe. |

Internal capabilities must describe supported read/write contracts, including
turn input, settlement/snapshot, and stream semantics. `inboxMaxVersion` and
`turnInputMaxVersion` alone do not establish compatibility. For example, a v1
parent may send input a v2 child understands while being unable to read the
child's v2 snapshot. The child must commit to a v1 return projection before work
starts, or that turn stays on compatible code. Do not drop fields to make an
otherwise incompatible result fit.

Framework-stamped accepting-deployment capabilities are immutable delivery data,
not user input. Negotiate request and return addresses independently and persist
the selection with the turn input. Missing, mixed, unsupported, or unrepresentable
capabilities keep a new owner on its pinned deployment, with an inspectable reason.
Do not silently route an active turn to a newly promoted deployment. Tasks and
authored workflow bodies already running retain their execution deployment and
their original reply contracts.

External v1 operations remain encodable for every owner in this topology. New
external operations require a capability check before persistence or a separately
versioned route; adding a discriminator and hoping an old reader ignores it is
not an upgrade strategy. The post-cut decoder retains old envelopes for the
lifetime of their possible producers and persisted events, not just until the
next package release.

### Existing agents upgrading to this release

The default upgrade preserves old sessions automatically through a legacy path:

1. **Route to the existing owner.** Session-ID ingress tries the new stable
   address and uses the existing legacy route on a definitive absence. Preserve
   session-ID behavior for each historical cohort and continuation-only access
   where that was its supported surface. Provider ingress uses the shared
   conversation claim described above. A timeout, uncertain resume, or decode
   error must never trigger creation of another session.
2. **Keep old messages readable.** Retain `resumeSessionInbox`, its v0
   `send`/`deliver` classifier, and every shipped version encoder required by live
   cohorts. Keep old authorization callback URLs, task replies, subagent replies,
   streams, cancel, clear, and reset routes usable. New-only operations return a
   clear unsupported-operation result without terminating the old session.
   Existing `steer` retains the old owner's semantics; new step-boundary steering
   is a new-owner behavior.
3. **Keep old child protocols executable.** Preserve the published stable entry
   references used by legacy parents and their input, report, request, outcome,
   cancellation, and state-return contracts. Register new topology under different
   entry IDs. A new deployment must not reject a supported old parent at the old
   `turnWorkflow` entry or translate its input into a new child while forgetting
   the old parent's reply hooks. Initially retain the legacy runner; sharing its
   internals with the new loop is optional, conditional on parity tests.
4. **Constrain code upgrades.** For legacy sessions, preserve compatible updated
   agent-code execution through that runner where verified. Where it cannot be
   represented, route the next turn to retained compatible code. New ingress
   must not stamp its own deployment as an execution target for an incompatible
   legacy parent. Already-persisted dispatches and old producers still require
   the old entry contract; changing new ingress metadata alone is not a repair.
5. **Preserve the operator's data and artifacts.** Retain the old deployment,
   authored modules, secrets/keys needed to read its state, and Workflow data
   until its runs and callbacks are retired. Upgrading the package does not
   rewrite hook records, erase history, or create a replacement conversation.

This needs a compatibility implementation, not merely a legacy decoder. Current
[dispatch](../packages/eve/src/execution/dispatch-turn-step.ts) routes to the
accepting deployment, and the
[old input migration](../packages/eve/src/execution/durable-session-migrations/turn-workflow.ts)
already distinguishes parent capabilities. Freeze actual published inputs and
outputs, including the unversioned cohort. Before enabling new owners, prove how
an incompatible dispatch that has already reached the old entry uses retained
code without another owner or repeated effects. If that cannot be provided for a
supported cohort, the release is blocked for that cohort; a reset is not the fix.

Keep one external claim key during rollout. Probing a legacy token and then
claiming an independently versioned token is a check/claim race: an old ingress
can win the old token while a new ingress wins the new one. The shared claim and
legacy conversation decoder avoid that split. Unknown owner entry IDs must fail
visibly rather than be guessed to be legacy or treated as an absent session.

There is no compulsory live-session conversion in the first release. Existing
sessions may remain on the compatibility path until they end; history transfer
to a new session with a new ID is a separate, explicit operation. A future
automatic transfer needs fencing of pending input, work, addresses, and streams.
Snapshot migration by itself cannot transfer a live run's durable cursors.

### Deployment retention, rollout, and rollback

Vercel deployment pinning is useful only while the old deployment and its
dependencies remain executable. Local/custom Worlds must also route old runs and
steps to retained artifacts. Persisting `.eve/.workflow-data` while replacing
the sole executable bundle does not establish replay compatibility. The rollout
must include a tested way to retain and route old executable generations on
supported self-hosted Worlds, or preserve their exact replay entry/step graph.
Treat this as a release gate; do not advertise in-place replacement as safe based
on a same-build restart test.

Use two rollout phases, which may be deployments of the same release:

1. Deploy compatibility-capable ingress and legacy execution support with new
   owner creation disabled. Verify old sessions through that deployment and
   retain it as the rollback target.
2. Enable new owners after the upgrade matrix passes. Existing sessions remain
   on their old topology. Observe routing, unresolved settlements, and retained
   run counts for both cohorts.

Rollback stops creating new owners and returns to a compatibility-capable
deployment. Existing new owners keep their pinned executable and routes. Rolling
the production alias back to a pre-bridge binary is not a supported rollback;
it cannot be assumed to understand new sessions or stream events. Document this
before enablement. Also test ordinary authored-code rollback within a supported
topology, including refusing to delegate new state to an older incompatible child.

Compatibility removal is based on retired runs, descendants, callbacks, queued
deliveries, and retry/retention horizons. The default 30-day session timeout is
not a removal deadline: `sessionTimeoutMs: false`, older deployments still
creating sessions, and delayed work can keep a cohort alive. Provide a bounded,
resumable inventory of these dependencies before cleanup. Owners that cannot be
retired keep their compatibility runtime; elapsed time must not brick them.

The implementation needs a minor changeset and coordinated stream/client/adapter
updates. Release docs must describe retained session behavior, code pinning,
the two rollout phases and rollback target, operator diagnostics, true steering,
`turn.interrupted`, the `ask()` return type, and delivery/recovery limits. The
[wire-schema plan](./session-inbox-wire-schema.md) remains the legacy contract;
this proposal extends it rather than deleting its compatibility obligations.

## Verification

These are implementation checks, not results established by this proposal.

### Published-consumer compatibility spike

The [redeploy probe](../e2e/fixtures/agent-inbox-upgrade/evals/inbox-upgrade.redeploy.eval.ts)
adds a published `eve@0.49.0` consumer alongside the retained `0.30.8` test.
Unlike the preview-pinned `0.30.8` parent, `0.49.0` dispatches later turns to the
accepting deployment. The probe records actual deployment IDs and workflow run
IDs to distinguish a resumed old body from a child using upgraded agent code.
It covers idle follow-up and stream resumption, pending blocking and background
answers, cancellation, new sessions, and agent-code rollback with the current
runtime retained. Session expiry is disabled. Hosted execution belongs to the
CI redeploy suite.

The [2026-09-04 hosted run at `617b68328`](https://github.com/vercel/eve/actions/runs/33898147026/job/101106035153)
found a baseline upgrade blocker before the unified topology is implemented:

| Transition from published `0.49.0`                             | Observed result                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle follow-up and saved stream cursor through current ingress | Same session ID; child executes current agent code on the accepting deployment; stream resumes.                                                    |
| Answer a parked blocking workflow, then send another message   | Original body finishes on its original run/deployment; the later turn executes current code.                                                       |
| Cancel a parked workflow, then send another message            | Cancellation is accepted; the next turn executes current code without a duplicate terminal boundary.                                               |
| Answer a background task after its initiating turn ends        | Original body completes on its original run/deployment and its result reaches the session.                                                         |
| Send the next user message to that task-owning session         | **Fails:** `turnStep` exhausts three retries and emits `session.failed` because `eve.tasks` has no version; the current reader requires version 2. |
| Create a fresh session after the upgrade                       | Parent and first turn execute on the new deployment.                                                                                               |
| Roll back authored code while retaining the current runtime    | Independent old and new task-free sessions preserve their IDs and execute the rolled-back code on a third deployment.                              |

The eval fails overall. It preserves the background-session failure while
finishing the independent rollback checks; 44 other assertions passed in this run.

The published parent stores an unversioned task index. The
[current reader](../packages/eve/src/tasks/session-index.ts) rejects it while
[building turn context](../packages/eve/src/tasks/delivery-context.ts), before
the requested tool runs. The outer turn-input version does not negotiate or
migrate this state. Task completion is therefore insufficient evidence of an
acceptable upgrade: the next ordinary message must also succeed, even when all
tasks have already settled.

This cannot be fixed by stamping `version: 2` alone. The
[published reader](https://github.com/vercel/eve/blob/eve%400.49.0/packages/eve/src/tasks/session-index.ts)
uses a strict unversioned schema and would reject that returned state. The
compatibility boundary must preserve both parent-readable state and old task
protocols, or execute this cohort on retained compatible code. Silently deleting
the task index or requiring a reset is not acceptable. Keep the failing hosted
probe as the first compatibility implementation gate; do not start replacing
the owner topology while this baseline remains broken.

The probe also established that alias propagation can route separate requests
to different deployments after `/info` first reaches the new one. Each code
transition uses bounded read-only turns and verifies actual execution provenance;
every accepted turn must preserve the session. The historical build stages the
published package with unusable source-only export conditions removed, without
changing runtime code. Retained production artifacts remain necessary.

This records behavior the legacy runner must preserve and a failure it must
fix. It does not implement the unified topology or prove arbitrary state projections. Authorization
callbacks, mixed-ingress conversation claims, remaining published cohorts, and
self-hosted executable retention remain release gates. The existing dev-server
generation scenarios cover live reload; their crash/restart case is skipped
pending abortable local queue delivery, so they do not establish a production
package-upgrade path.

### First compatibility implementation

The first implementation takes the retained-executable option. New parents stamp
`driverCapabilities.stateContractVersion: 1`, independently of the outer
turn-input version. The value covers both nested session state and the state
returned to the parent; incompatible changes must advance it. A missing or
nonmatching contract on Vercel resolves the session parent's original deployment
before the child claims hooks or executes agent code. If the child is already
on that deployment, it executes there; otherwise it forwards the exact original
input to the retained `turnWorkflow` entry. That child continues using the same
parent stream, reply, cancellation, and pending-work contracts. New sessions with
matching contracts retain ordinary accepting-deployment code upgrades.

This deliberately pins pre-boundary sessions to original agent code, including
task-free sessions: absence of task state does not prove that the next turn will
not create incompatible state. There is no state rewrite or automatic conversion.
The forwarding run does not own or proxy the old child's hooks. Its prepare step
persists the target and a World-generated run ID before the start step; retries
of that start reuse the ID, including after child completion and hook disposal.
The Workflow integration test injects a lost queue acknowledgement and retries
again after completion. Parent dispatch deduplication across separately created
forwarding runs remains part of the broader start-idempotency release gate.

The published-consumer probe now requires the formerly failing task-owning
session to accept its next message on retained code, then admit, answer, and
finish another background task. It also starts new blocking work after upgrade,
verifies current code for fresh sessions, and checks both cohorts through
agent-code rollback. Hosted results for this implementation are pending.
Self-hosted retained-generation routing and full runtime downgrade remain
unimplemented release gates.

### Refactor release gates

Start with these counterexamples before wiring the full runtime. Record the
observed event history and compare live execution with replay; a same-process
unit mock is insufficient for the Workflow boundaries.

| Pressure test                                                                                                    | Required result                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Steer and model settlement arrive through different hooks around finalization; replay after each boundary        | One reproducible decision, no early terminal event, no dropped steer, and foreground progress under sustained input.      |
| Child finishes, releases its inbox, then the parent's start step retries                                         | The completed logical operation is found; its authored body does not run again.                                           |
| Child commits terminal state, then crashes before report or return; parent also receives a late duplicate report | Recover one authoritative settlement without repeating effects or terminal emission.                                      |
| Task cancellation and address registration occur at the parent while a delegated turn finishes                   | Child adoption preserves both parent changes and accounts for every forwarded input.                                      |
| Old and new ingress concurrently start the same provider conversation                                            | Exactly one claim winner; losing initial input reaches that owner using its understood contract.                          |
| Older parent starts a child on the new deployment with old input and pending ask/task state                      | Complete the old reply protocol or safely execute on retained compatible code; no rejected entry that strands the parent. |
| New child can decode old input but cannot represent its result for the old parent                                | Compatibility fails before execution; the owner keeps usable state and compatible execution.                              |
| Replace/restart a self-hosted deployment with a session waiting on a hook and an authored workflow sleeping      | Old histories and pending steps use their retained executable generation; later input still reaches the same session.     |

Cross-version CI must use actual published consumers, not only current code with
an old `version` field. Cover the legacy `deliver` cohort, the actual 0.30.8
`send` consumer, stamped wire cohorts, and the last pre-refactor release. Use a
synthetic second post-cut contract to test negotiation before a second version
ships, then retain its published counterpart. For each relevant cohort include an idle follow-up,
an active tool, a pending answer/auth callback, a background task, and a resumed
stream. Preserve the existing
[published-consumer redeploy eval](../e2e/fixtures/agent-channels/evals/custom-channels/cross-version-session-inbox.eval.ts).
Exercise both ingress directions, code upgrade and rollback, and disabled
session expiry. Freeze the supported cohort matrix before implementation; do not
narrow today's support merely to make the new tests pass.

| Area                            | Required evidence                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small Workflow spike            | Dynamic reader registration wakes a parked merge; per-hook order and merged step-boundary decisions survive replay/restart; abort and reader failure wake foreground work; disposal releases every reader. Verify supported Worlds, including Local, Vercel, and configured Postgres, plus retry horizons.          |
| Structural inventory            | New owners have one inbox, one hook per address, and no per-answer/cancel/report/reply hooks. A blocking tool adds only its own run and hook. New hooks omit metadata; account separately for compatibility discovery, retained legacy owners, and operation retention.                                             |
| Execution parity                | Inline and delegated turns use the same handlers for tools, asks, runtime calls, sleep, task admission, cancellation, and supervision. Same-deployment work never creates a turn workflow. Background-task replies reach the session after the initiating turn ends.                                                |
| Turn semantics                  | Steer at natural completion keeps the turn ID without a terminal frame; interrupt/cancel precedence and state preservation hold; finalizer retries retain event identities. Preserve `tasks: true` cancellation during active and parked sessions.                                                                  |
| Ownership and recovery          | Initial claim losers never run; scheduled anchoring conflicts are visible; old addresses remain live; late start retries never repeat a completed operation; settlement preserves parent changes and accounts for all input. Recover missing reports with session expiry disabled.                                  |
| Other traffic and compatibility | Concurrent asks, tasks, subagents, authorization, and collectors share owner inboxes. Cover duplicates across addresses, stale input, durable backlog and capacity bounds, and address cleanup. Run the published-cohort matrix, mixed-ingress claim race, retained-generation restart, and rollback tests.         |
| Hosted performance              | Same-SDK paired measurements cover inline blocking tools and background tasks as well as delegated turns, including ingress, finalization, supervision, and replay. Verify removal of the extra turn start and relay; report durable operations, state size, and latency against the benchmark's acceptance budget. |

Use unit tests for reducers, Workflow-backed scenarios for scheduling and failure
boundaries, and deterministic fixture evals in CI for streamed behavior. Relevant
fixtures include `agent-workflow-tools`, `fixture-tasks`, and `agent-channels`.

Review baseline: `ccbd4b6a4`, with the repository and installed dependency both
pinning `@workflow/core@5.0.0-beta.47`. The current
[session inbox](../packages/eve/src/execution/session-command-inbox.ts),
[child turn](../packages/eve/src/execution/turn-workflow.ts),
[owner channels](../packages/eve/src/execution/tools/workflow/owner.ts), and
[task workflow](../packages/eve/src/execution/tasks/child/workflow.ts) establish
the inventory. [Slack anchoring](../packages/eve/src/public/channels/slack/slackChannel.ts)
currently replaces its temporary continuation address after posting.
[Inline turn control](../packages/eve/src/execution/inline-turn.ts)
and [harness emission](../packages/eve/src/harness/emission.ts) establish the
steering/finalization boundary. Metadata behavior is visible in
[eve ingress](../packages/eve/src/execution/wire/session-inbox-resume.ts) and
[Workflow's resume implementation](https://github.com/vercel/workflow/blob/7cc5c88a8bb2fad48353dd006c6ca1f28190ab46/packages/core/src/runtime/resume-hook.ts).
The upgrade review also uses
[stable workflow IDs](../packages/eve/src/execution/stable-workflow-names.ts),
[session runtime routing](../packages/eve/src/execution/workflow-runtime.ts), and
[Slack token derivation](../packages/eve/src/public/channels/slack/api.ts).
