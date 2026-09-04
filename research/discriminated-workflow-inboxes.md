---
issue: https://github.com/vercel/eve/issues/876
status: proposed
last_updated: "2026-09-04"
---

# Stable session streams, replaceable holders, and owner inboxes

Use a small **holding workflow** to initialize a session, reserve its addresses,
and maintain its control lifecycle. It durably starts the first turn after the
session resources are ready. Ingress starts subsequent turn candidates directly;
the candidate that claims the session's active-turn hook executes and terminates
when its work settles. Each receiving execution owner uses one discriminated
inbox for input, cancellation, reports, requests, and replies.

The public session and stream remain stable while turn workflows and, when
necessary, the holding workflow run on newer code. A replacement holder references
the original stream and committed state; retirement does not close that stream.
The holder does not run the agent, relay ordinary messages, interpret checkpoints,
or adopt turn results. Its code changes only for its small control protocol.

This is the complete proposal for [PR #3005](https://github.com/vercel/eve/pull/3005).
It replaces that PR's same-deployment inline turns, cross-deployment child turns,
parent settlement exchange, and reset-only deployment cut. It retains and
integrates the inbox, steering, finalization, tool, task, and supervision contracts
below. No companion architecture proposal is required. Runtime implementation
remains gated on the explicitly identified Workflow and recovery proofs.

## Ownership and identity

```text
POST /session(initial event)
  -> start holder H(initial event)
       -> initialize session S, streams, checkpoint, and address claims
       -> durably start first candidate T1(S, initial event)
       -> wait for register / adopt / retire / close commands

follow-up(S) ---------------------------------> start candidate T(S, event)
provider or callback -> lookup alias -> H
  -> resolve H's session reference -> S ------> start candidate T(S, event)
                                                        |
                                              claim active-turn(S)
                                                /               \
                                          execute          forward to owner;
                                             |             retain input until
                                             |             disposition is known
original session streams <-------------------+-- progress and checkpoints
```

| Responsibility                                     | Owner                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| Stable public identity and readable stream         | Original session and stream identity                                |
| Bootstrap and first-turn dispatch                  | Initial holding workflow                                            |
| Continuation/callback addresses and additive rekey | Current holding workflow                                            |
| Replacement and stream closure                     | Versioned holder control protocol                                   |
| Model execution, steering, tools, and finalization | Winning terminating turn workflow                                   |
| Mutable state between turns                        | Durable versioned checkpoint, interpreted by turn code              |
| Unapplied input                                    | Its durable candidate until accounted for or explicitly transferred |
| Background work                                    | Independent task workflow; later updates enter session ingress      |

Keep three internal identities distinct: `sessionId`, `streamRunId`, and
`holdingRunId`. On creation all three can equal the initial holder's run ID.
Replacement changes only `holdingRunId`; public session IDs can retain their
Workflow run-ID format. Each holder publishes an immutable reference containing
the stable IDs, its generation, and protocol capabilities. These are ordinary
versioned data, not `HookOptions.metadata`. Provider lookup resolves this reference
instead of treating `hook.runId` as the public session ID.

Session lookup, status, cancellation, and expiry resolve the active generation
and committed session state. The original stream run completing does not mean
the session completed; APIs must not infer session liveness from that run's status.

The holder's control token and the active-turn token derive from **session ID**,
not the current holding run, candidate run, or logical turn ID. Turn run IDs and
logical turn IDs are separate: a forwarding candidate might never execute a turn.
An executing turn may suspend for tools, sleep, or input, but does not stay alive
between settled turns to own the session.

New execution uses the deployment that accepted its input. Steering an already
active turn uses that owner's deployment and negotiated protocol. Queued input
retains its accepting-deployment reference for its eventual execution. A deployment
change alone neither replaces the holder nor moves an in-progress authored body.

## Session creation and ingress

HTTP creation performs one start: `holdingWorkflow(createInput)`, whose durable
input includes the initial event and its identity. The holder completes resource
initialization before a separate durable step starts the first turn. Initialization
must finish stream writes, initial checkpoint publication, and required address
claims. Calling `getWritable()` alone is not a readiness barrier.

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
responsibility until acknowledged. A lookup miss during replacement must follow
the migration protocol below instead of starting a new session.

Rekey means **claim another address** through the holder's control inbox. Success
requires a durable claim and an acknowledgement or confirming lookup. Repeating
an address owned by the same holder is a no-op; an address belonging to another
session is a visible conflict. Previously claimed addresses remain until session
closure or confirmed replacement. Threadless Slack sessions register their thread
after the first post returns its timestamp; the post/claim interval needs startup
reconciliation so a racing reply cannot create a second executing session.

Authorization uses one random, session-scoped callback capability with at least
128 bits of entropy, registered before exposing a challenge URL. Its alias survives
turn completion and holder replacement. Callback ingress accepts bounded parameters,
resolves the session, and admits only an `authorization.response`; it cannot select
arbitrary tokens or event kinds. The reducer matches the pending connection and
attempt, and the connection strategy validates provider state. Secrets and
capabilities stay out of logs.

Task updates, late input responses, cancel, clear, compact, reset, and timeout also
use session admission when no turn is active. A candidate can process control or
settle an obligation without starting a model request. Blocking-tool traffic goes
directly to its active turn's inbox. Ordinary provider and callback events do not
wake the holder.

## One logical inbox per receiving owner

A logical inbox owns its readers, shared buffer, correlations, decoder, and reducer.
Each receiving hook has one reader and accepts the owner's discriminated protocol.
Additional hooks reserve distinct addresses or address independent executions;
message kinds and request IDs do not create hooks. All eve-owned hooks are
server-only (`isWebhook: false`) and omit `HookOptions.metadata`.

| Owner/address          | Proposed token or scope                    | Purpose                                                                   |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Holder control         | `eve:session-control:v1:<sessionId>`       | Bootstrap control, address registration, adoption, retirement, closure    |
| Provider alias         | `eve:continuation:v1:<provider-address>`   | Lookup of the current holder and stable session reference                 |
| Authorization alias    | `eve:auth-callback:v1:<random-capability>` | Authorized callback lookup independent of the active turn                 |
| Active turn            | `eve:turn-inbox:v1:<sessionId>`            | Session-wide exclusion and active-owner input, reports, requests, replies |
| Blocking workflow tool | `eve:workflow-tool-inbox:v1:<operationId>` | One independently executing authored body                                 |
| Background task        | `eve:task-inbox:v1:<taskId>`               | Work and requests that can outlive the initiating turn                    |
| Activity collector     | Existing random callback capability        | Independent batch reduction, debounce, and expiry                         |

Provider and authorization hooks are intentional **lookup-only aliases**. They
replace #3005's direct provider-to-session resume and its prohibition on lookup-only
hooks. Only receiving hooks feed an inbox; an alias's job is to reserve an address.
Holder control requests use correlated results or confirming reads without creating
per-request reply hooks.

A session with `C` provider addresses and `A` callback aliases owns `1 + C + A`
holder hooks while idle, plus one claimed turn hook while executing. Each blocking
tool, background task, or collector adds one. Counts exclude authored hooks and
transient migration/recovery coordination. There is no parent turn inbox or
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

Successful resume proves durable receipt, not application. The retained Local
World spike reproduces an owner receiving a message after its last application
decision and then completing without applying it. A loser must not do
`resumeHook(); return`.

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
runtime obligations, terminal state, and owner/generation/revision information.

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
| Address registration, adoption, retirement, closure commands/results   | Holder control, with session generation and request identity                    |

There is no parent `turn.settled` exchange. Committed state and event dispositions
replace parent adoption. Framework encoders own identity, targets, and capabilities;
client payloads cannot override them. Resource authorization precedes lookup and
admission. Mixed content and input answers become separate ordered events, retaining
both. Pure answers do not accidentally become steering messages.

Durable sends derive IDs from the step and logical send key, never the attempt.
Provider IDs are namespaced; HTTP ingress mints an ID before retryable work. A new
HTTP request remains a new submission, without a new public idempotency-key API.
Deduplication spans aliases, candidates, turns, and holder generations for the
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
and disposal under Workflow replay still require the planned pump spike.

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

## Stream access and holder replacement

The installed `@workflow/core@5.0.0-beta.48` exposes `getWritable()` for the current
run, with namespaces, and `getRun(id).getReadable()` for other runs. A run ID alone
is not a public foreign-run writer API. The SDK can serialize writable handles
that retain their original run identity.

The retained spike publishes output/checkpoint handles once in a closed bootstrap
namespace. Turn steps resolve those handles through the original stream run and
write directly, without waking the holder. Use this supported serialization path
for the prototype; isolate access behind an eve-owned adapter. Shipping requires
verification of encryption, flushing, deployment compatibility, and hosted lifetime.
The spike's sequential numeric checkpoint is not the production commit protocol.

Holder inputs have separate `create` and `adopt` forms. Adoption carries stable
session/stream IDs, a committed checkpoint reference, address inventory, pending
delivery ownership, and upgrade identity/generation. It creates neither a new
output stream nor an initial turn.

```text
session S ---> original stream run R (retained storage identity)
    |
    +-- H1 on deployment A -- retire without closing R
    |
    +-- H2 on deployment B -- adopt S / R / committed state / addresses
                                  |
                            future turns write to R
```

Compare declared control, inbox, turn-input, and checkpoint capabilities with the
accepting deployment's requirements. A compatible holder remains in place.
Breaking requirements select an explicit migration; generic runtime failures do
not trigger replacement. Put adoption/retirement support in the first holder
version so later code can negotiate with already-pinned execution. Unsupported
rollbacks and unrepresentable inputs fail before effects; do not silently reset
the session or fall back to an incompatible deployment.

An incompatible replacement has these durable phases:

1. Serialize upgrade with admission, settle or safely quiesce the active turn,
   and commit state, unresolved input ownership, and the address inventory.
2. Prepare the latest holder against that state and publish recoverable migration
   routing discoverable by each address independently of either holder. Creation
   on a lookup miss must consult that routing.
3. Transfer address claims, activate one generation, and resume admission. Retry
   identities and durable recovery must converge concurrent upgrades and recover
   partial transfers. Fence superseded holders from rekey, close, and state writes.
4. Retire the old holder without session-terminal events or stream closure.

Disposing one hook and claiming it in another run are separate operations. The
Local World spike proves sequential token reuse, not atomic address transfer.
Migration routing/reservations must survive coordinator failure and prevent a
provider lookup gap from creating a second session. This is a required proof,
not a guarantee supplied by `getConflict()`. The same rule covers callback aliases
and control-token transfer. An idle gap in the active-turn token has no such lookup
responsibility.

Adopting an existing `entryWorkflow` additionally requires a verified adapter for
its pinned version: quiesce execution and extract state, obligations, input, and
emission counters from its journals. Stream reference alone cannot migrate that
state. Old code may lack export/retirement support; unsupported legacy sessions
need an explicit migration limitation, not a claim of universal adoption or a
silent reset. This replaces the earlier #3005 policy that reset every pre-cut
session and started a new provider session.

Reference the original stream rather than transfer its physical ownership. URLs,
event IDs, existing readers, and resume cursors remain stable. Source stream data,
metadata, and encryption material must remain available after retirement; replacing
the holder does not renew retention or permit deleting the original storage run.
Verify completed-source writes, live reads, historical decoding, cross-deployment
keys, and retention on every supported World. If a World requires an active source
run, full holder disposal requires a stream-lifetime primitive before shipping.
Holder replacement can bound control replay history; it does not bound shared
stream or conversation history. Checkpoint size and storage costs remain measured
parts of the design.

Actual session closure fences admission, settles or cancels dependants, accounts
for pending input, and flushes terminal output. Authored lifecycle work runs in
terminating execution. Only then does the current holder accept a generation-checked
generic close command, close shared streams, and release addresses. Retirement
and closure are distinct operations.

## Evidence and implementation gates

The [three retained tests](./spikes/adjacent-session-workflow/spike.integration.test.ts)
and [spike workflows](./spikes/adjacent-session-workflow/workflows.ts) passed against
the Local World on eve `a37938d3d225e87071e15d135ee17189e5188f20`, using
`@workflow/core@5.0.0-beta.48`. They establish independent terminating writers,
sequential checkpoints, additive alias lookup, a received-but-unapplied event,
and continued reads/writes after completing the original holder and adopting its
stream in a replacement. Both an attached reader and a saved resume cursor retain
continuity. They do not prove the candidate protocol or production migration.

Reproduce in a disposable checkout; the test builder requires these discovery paths:

```sh
cp research/spikes/adjacent-session-workflow/workflows.ts packages/eve/src/internal/testing/adjacent-workflow-spike.ts
cp research/spikes/adjacent-session-workflow/spike.integration.test.ts packages/eve/src/execution/adjacent-workflow-spike.integration.test.ts
pnpm --filter eve build:js
pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/execution/adjacent-workflow-spike.integration.test.ts
rm packages/eve/src/internal/testing/adjacent-workflow-spike.ts packages/eve/src/execution/adjacent-workflow-spike.integration.test.ts
```

Implement as one topology, with these gates in order:

| Gate                           | Required evidence                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap and durable delivery | Holder initialization before first start; early follow-ups; retried/duplicate starts after hook release; queue ordering; late finalization input; actual-owner changes; failed candidates observable without new traffic. |
| State and execution safety     | Checkpoint commit/replay; stale writers after hard cancellation; output flush; no duplicate effects or terminal outcomes during recovery; bounded acknowledgement and supervision cost.                                   |
| Inbox and turn behavior        | Dynamic reader registration/replay/disposal; queue/steer/interrupt/cancel precedence at model, tool, sleep, ask, auth, and finalization boundaries; no lost input or premature lifecycle effects.                         |
| Tools and late events          | Blocking tool and background task ownership; concurrent asks and runtime replies; send failure and cancellation cleanup; late task/auth/input events with no active turn.                                                 |
| Replacement                    | Compatible deployment reuse; create versus adopt; concurrent upgrades/ingress, lookup gaps, partial address transfer, coordinator failure, and stale-holder fencing; explicitly supported legacy state extraction.        |
| Hosted stream lifetime         | Encrypted cross-deployment writes and reads, source completion, cursor continuity, historical decoding, retention, and closure on supported Worlds.                                                                       |
| End-to-end and performance     | Deterministic fixture coverage and paired hosted measurements against current main and the earlier inline proposal; include starts, claims, checkpoint I/O, forwarding candidates, and recovery work.                     |

Use unit tests for reducers, Workflow-backed scenarios for durable scheduling and
failure boundaries, and CI fixture evals for streaming behavior (`agent-workflow-tools`,
`fixture-tasks`, `agent-channels`). Follow [turn performance](./turn-performance.md)
for paired measurements. The prior successor experiment's continuously owned turn
token is unnecessary here, but durable input ownership remains mandatory. There is
no hosted performance result for this topology yet.

Runtime implementation must update session/upgrade documentation, steering and
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
