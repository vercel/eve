---
issue: https://github.com/vercel/eve/issues/876
status: proposed
last_updated: "2026-09-03"
---

# One logical inbox per durable owner

eve should give each receiving workflow one logical inbox: a set of hooks that
accept the same discriminated event protocol and feed one buffer and reducer.
Each hook reserves an address through which that owner can receive messages.
Every session starts with its stable session-ID hook, then adds external
addresses when they become known. Senders resume the addressed hook directly.
All eve-owned hooks omit `HookOptions.metadata`.

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

## Before and after

A **logical inbox** owns the hook readers, shared buffer, correlations, and
reducer. A **hook** reserves one address and has one reader in that inbox.
Workflow routes a hook token to its owning run; that run then interprets the
event's discriminator and correlation IDs. Add a hook only to address another
independently running owner or reserve another address for the same owner.
Cancellation, reports, requests, replies, and individual operations use event
fields in the existing inbox. There are no lookup-only hooks.

`A` below is one optional authorization callback hook, added when needed.
Counts exclude application-authored hooks and webhooks.

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

| Address                | Token                                      | Why this hook exists                                                                                   | Ownership claim              |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Stable session         | `eve:session-inbox:v1:<runId>`             | Addresses the session by ID and receives inline-turn traffic                                           | None; unique to the run      |
| External conversation  | `eve:continuation:v1:<provider-address>`   | Reserves a provider identity so ingress can reach the session without knowing its run ID               | Once per distinct address    |
| Authorization callback | `eve:auth-callback:v1:<random-capability>` | Gives the session an unguessable callback address; connections and attempts remain event fields        | None; random, session-scoped |
| Delegated turn         | `eve:turn-inbox:v1:<turnId>`               | Wakes the turn executing on another deployment; a session-inbox event wakes only the session           | Before owner work            |
| Workflow-tool run      | `eve:workflow-tool-inbox:v1:<operationId>` | Addresses an independent blocking tool execution with its own body, cancellation scope, and settlement | Before owner work            |
| Background task        | `eve:task-inbox:v1:<taskId>`               | Addresses admitted work whose execution and input requests can outlive the initiating turn             | Before owner work            |
| Activity collector     | Existing random callback capability        | Addresses the separate activity reducer with its own debounce and expiry                               | Before owner work            |

Every hook above is iterated, server-only (`isWebhook: false`), and created
without `metadata`. The session creates and owns all of its address hooks,
including addresses discovered while a child turn is running.

Independent owners retain `start()` plus `getConflict()`: each candidate creates
its inbox and reader before claiming; only the winner executes the body. Losers
dispose their inboxes and exit without publishing an outcome. A child turn drops
from two sequential claims to one. Start retries use the same logical token.
Durable start idempotency remains separate work: a retry after the original
owner releases its token can still repeat work.

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

All session hooks accept the same wire protocol. Tool traffic returns directly
to the workflow that owns the turn:

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

After existing authorization checks, session-ID ingress derives the stable
token; provider and callback ingress derive their own namespaced tokens. Each
calls `resumeHook(token, envelope)` directly. No eve lookup translates an external
address into the stable address, and no hook metadata selects the protocol.
Workflow still resolves the token internally. Direct token resume avoids the
metadata-discovery preflight used by current continuation ingress; ordinary
stable-session ingress already has a direct fast path. Explicit session lookup
and child supervision may still read hook ownership when they need the run ID.

External addresses include the channel and provider conversation scope. For
Slack, the identity includes the installation/workspace, channel, and
`threadTs ?? ts`; a timestamp alone is not a global address.

Internal senders receive an `InboxAddress` containing a token and
`protocol: { family: "eve-inbox", version: N }` in durable input or
framework-owned state. That version selects the exact envelope to encode.
External session, provider, and callback ingress always send version 1 for this
topology. The token's `:v1:` identifies the topology, independently of later
envelope versions.

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

Every owner awaiting a child outcome has durable supervision, independent of
session expiry or new user traffic. A shared Workflow sleep and bounded status
reads detect terminal children with missing reports, allowing a reconciliation
interval for delayed settlement. Supervision follows the inbox's owning run,
which may differ from the candidate returned by `start()`.

A missing report or exhausted supervision reads causes a visible failure while
retaining the last committed state and unresolved input. Automatic execution
stops because replaying input could repeat already-applied work. Recovery must
not invent a second terminal outcome if the child already emitted one. A healthy
active child remains running. This also applies to tool/task children and remains
active when `sessionTimeoutMs: false` disables session expiry.

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

Ship the new tokens, envelopes, owner inputs, callback routing, and terminal
emission together as the `owner-inbox-v1` topology. All hooks in an owner's
inbox share its protocol contract. New routes do not resume old
hooks: pre-cut session IDs require a reset, and provider activity on an old
thread starts a new session. Child entry points reject pre-cut inputs before
creating hooks or executing work.

External ingress stays on the frozen version-one contract. Internal upgrades
use framework-stamped accepting-deployment capabilities: topology,
`inboxMaxVersion`, and `turnInputMaxVersion`. The parent selects versions both
deployments support and passes explicit addresses and inputs. Mixed, missing, or
unrepresentable capabilities keep execution pinned. Unsupported operations fail
before resume. New consumers read earlier post-cut versions; incompatible
external changes require a new routing design or topology cut.

This replaces the pre-cut compatibility policy and metadata discovery in the
[wire-schema plan](./session-inbox-wire-schema.md). The implementation needs a
minor changeset and coordinated stream/client/adapter updates. Published docs
and release notes must cover session reset, steering versus interruption,
`turn.interrupted`, the `ask()` return type, additive continuation addresses,
and delivery/recovery limits. The session-ID format is unchanged.

## Verification

These are implementation checks, not results established by this proposal.

| Area                            | Required evidence                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small Workflow spike            | Dynamic reader registration wakes a parked merge; per-hook order and merged step-boundary decisions survive replay/restart; abort and reader failure wake foreground work; disposal releases every reader. Verify supported Worlds, including Local, Vercel, and configured Postgres, plus retry horizons.          |
| Structural inventory            | One inbox per receiving owner; one hook per address; no per-answer/cancel/report/reply hooks. An inline blocking-tool call starts only the tool run and adds one hook; delegation to another deployment adds one turn run and hook. All hooks omit metadata and accept direct delivery.                             |
| Execution parity                | Inline and delegated turns use the same handlers for tools, asks, runtime calls, sleep, task admission, cancellation, and supervision. Same-deployment work never creates a turn workflow. Background-task replies reach the session after the initiating turn ends.                                                |
| Turn semantics                  | Steer at natural completion keeps the turn ID without a terminal frame; interrupt/cancel precedence and state preservation hold; finalizer retries retain event identities. Preserve `tasks: true` cancellation during active and parked sessions.                                                                  |
| Ownership and recovery          | Initial claim losers never run; scheduled anchoring and mid-session claim conflicts behave explicitly; old addresses remain live; handoff never repeats work; settlement accounts for all input. Missing reports remain detectable with session expiry disabled.                                                    |
| Other traffic and compatibility | Concurrent asks, tasks, subagents, authorization, and collectors share owner inboxes. Cover duplicates across addresses, stale input, all capacity bounds, address cleanup, pre-cut reset, newer ingress to older parents, and internal upgrades/rollback.                                                          |
| Hosted performance              | Same-SDK paired measurements cover inline blocking tools and background tasks as well as delegated turns, including ingress, finalization, supervision, and replay. Verify removal of the extra turn start and relay; report durable operations, state size, and latency against the benchmark's acceptance budget. |

Use unit tests for reducers, Workflow-backed scenarios for scheduling and failure
boundaries, and deterministic fixture evals in CI for streamed behavior. Relevant
fixtures include `agent-workflow-tools`, `fixture-tasks`, and `agent-channels`.

Source baseline: eve main `e83e50e4d5801d2d4378ae37aec1b98f55a0d5c6`, with
`@workflow/core@5.0.0-beta.48`. The current
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
