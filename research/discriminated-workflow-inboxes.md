---
issue: https://github.com/vercel/eve/issues/876
status: proposed
last_updated: "2026-09-03"
---

# One operational inbox per durable owner

eve should use one operational inbox for each independently running workflow
that receives messages. Messages, controls, and correlated replies become
discriminated events on that inbox. A background pump reads events in persisted
order into a bounded buffer; the active owner applies them at step boundaries.
Continuation aliases and authorization callbacks become lookup-only hooks.
All eve-owned hooks omit `HookOptions.metadata`.

This refactor addresses three connected problems:

- Separate hooks for messages, cancellation, reports, and replies create
  multiple durable cursors, claims, and lifecycle paths for the same owner.
- Current `steer` behavior aborts and replaces the turn. True steering needs
  input to arrive during a step and join the same turn at its next boundary.
- The harness can publish `turn.completed` before the workflow inspects newly
  arrived input. The owner must decide whether to continue before finalizing.

The expected gains are fewer durable operations and consistent input and
settlement semantics. Hosted latency remains a measured outcome: hook counts
alone do not establish a fix for [#876](https://github.com/vercel/eve/issues/876).
Use the paired benchmarks in [turn performance](./turn-performance.md).

The design assumes the background pump is Workflow-safe. A small spike will
verify scheduling, replay, cancellation, and disposal before production conversion.

## Before and after

An **operational inbox** is an iterated hook that receives runtime events. A
**lookup hook** has no consumer; its built-in owning `runId` locates the session.
Counts below exclude application-authored hooks and webhooks.

| Owner                                | Current hooks                                                                  | Proposed hooks                                                           | Operational count          |
| ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------- |
| Session without a continuation alias | Stable inbox and gated authorization hook                                      | Stable inbox; optional authorization lookup                              | 2 → 1                      |
| Session with a continuation alias    | Stable inbox, iterated alias, and gated authorization hook                     | Stable inbox; continuation and optional authorization lookups            | 3 → 1                      |
| Additional child turn                | Inbox, cancellation, parent control, and workflow report/request/outcome hooks | Turn inbox; reports and settlement return to the parent's existing inbox | 6 → 1                      |
| Additional workflow-tool run         | Control inbox, plus a hook per answer or agent reply                           | Workflow-tool inbox with request-ID correlations                         | 1 + answer/reply hooks → 1 |
| Background task                      | Command inbox, workflow report/request/outcome hooks, and answer/reply hooks   | Task inbox; same-owner body results return in memory                     | 4 + answer/reply hooks → 1 |
| Activity collector                   | Batch hook                                                                     | Collector inbox                                                          | 1 → 1                      |
| Session timeout                      | Sends to the session inbox                                                     | Sends to the session inbox                                               | 0 → 0                      |

The ordinary same-deployment turn remains inline and creates no turn hook.
Accepted-deployment upgrades, sleep, background work, and coordination can still
require a child. The session remains pinned and owns canonical session state.
Tool/task body placement follows [subagent execution boundaries](./executor-neutral-core.md).

### Proposed hook inventory

| Owner or lookup      | Token                                      | Consumer                               | Ownership claim               |
| -------------------- | ------------------------------------------ | -------------------------------------- | ----------------------------- |
| Session              | `eve:session-inbox:v1:<runId>`             | Session pump, shared with inline turns | None; unique to the run       |
| Continuation lookup  | `eve:continuation:v1:<provider-address>`   | None                                   | Initial claim and each re-key |
| Authorization lookup | `eve:auth-callback:v1:<random-capability>` | None                                   | None; random, session-scoped  |
| Child turn           | `eve:turn-inbox:v1:<turnId>`               | Turn pump                              | Before owner work             |
| Workflow-tool run    | `eve:workflow-tool-inbox:v1:<operationId>` | Workflow-tool pump                     | Before owner work             |
| Background task      | `eve:task-inbox:v1:<taskId>`               | Task pump                              | Before owner work             |
| Activity collector   | Existing random callback capability        | Collector pump                         | Before owner work             |

Every hook above is server-only (`isWebhook: false`) and omits `metadata`
entirely. Lookup hooks store no eve routing payload. The session creates its
own lookups, so Workflow's owning `runId` supplies the association.

Independent owners retain `start()` plus `getConflict()`: each candidate creates
its inbox and reader before claiming; only the winner executes the body. Losers
dispose their inboxes and exit without publishing an outcome. A child turn drops
from two sequential claims to one. Start retries use the same logical token.
Durable start idempotency remains separate work: a retry after the original
owner releases its token can still repeat work.

## Routing and event contract

```text
session-ID request -----------------------------+
                                               |
provider event -> continuation lookup -> runId --+-> stable session inbox
                                               |       |
auth callback -> capability lookup -> runId -----+       v
                                                  session pump
                                                       |
                                                  session buffer
                                                       |
                                                  session owner
                                                  /           \
                                           inline turn     child turn inbox
                                                               |
                                                            turn owner
                                                          /            \
                                                 workflow-tool       task inbox
                                                     inbox

Child reports and settlement return to the parent's existing inbox.
Each independent receiving owner has its own pump and buffer.
Same-owner calls and results stay in memory.
```

After existing authorization checks, session-ID ingress derives the stable
token and resumes it directly. Provider and callback ingress look up their
namespaced hook, validate its token and owning run ID, then derive that same
stable token. Resume uses the token, without a stable-hook preflight or metadata
discovery. In the reviewed SDK, omitting metadata skips its hydration and key
resolution path.

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
| `turn.continuation-changed`                                            | Session                                | Active turn ID                                                           |
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
  pending correlations stay protected. Buffers, bytes, waiters, and deduplication
  state have explicit bounds; overflow fails visibly instead of evicting input.
  Exact capacities and retention follow the spike and retry-contract review.
- Invalid versions, kinds, or owner/target combinations fail visibly. Valid but
  stale events follow their domain rules. Schemas remain append-only, with
  server/step-safe encoders and dependency-free workflow decoders, following
  [the wire-schema plan](./session-inbox-wire-schema.md).

## Background pump and turn decisions

One background async iterator continuously feeds the owner's buffer while the
foreground awaits a model/tool step, sleep, claim, or authored workflow body.
It wakes matching waiters and signals cancellation or interruption to the active
abort scope. The foreground reducer owns state changes and lifecycle decisions.

```text
inbox -> background pump -> decode / deduplicate -> bounded buffer
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
targets; a stale cancel cannot affect a later turn. Abort is cooperative: streamed text and completed tool
effects cannot be undone. Accepted user input, admitted tasks, usage, and existing
cancellation-state carve-outs survive; admitted tasks need their own cancellation.

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

## Lookup lifecycle and child accounting

A channel-created session opens its stable inbox before claiming the continuation
lookup. A losing candidate forwards initial and buffered input to the winner
with the original event identities, closes its own records, and exits without
starting a turn. Registration retries are bounded; startup delays must not start
duplicate sessions.

Re-keying claims the new continuation while the stable pump continues reading.
On conflict, keep the old continuation. On success, persist the new identity
before retiring the old lookup. Both may briefly resolve to the same inbox;
ordering begins at durable inbox acceptance.

Interactive authorization uses one cryptographically random, session-scoped
callback capability with at least 128 bits of entropy. It is created before
exposing a challenge URL and retained across re-keys. The callback
route accepts only bounded authorization parameters and constructs a version-one
`authorization.response`. It cannot accept arbitrary operational tokens or event
kinds. A response must match the pending connection and attempt; the connection
strategy still validates provider state. Capabilities and returned secrets stay
out of logs and diagnostics. Session closure disposes both kinds of lookup.

### Handoff, forwarding, and settlement

```text
session owner                             child turn owner
     |                                          |
     |-- durable start input ------------------>|
     |   initial delivery or inline handoff     |-- create inbox + claim
     |                                          |-- execute / adopt handoff
     |-- later event, retaining a copy -------->|
     |                                          |-- reduce + finalize
     |<-- turn.settled -------------------------|
     |    state/result + applied event keys     |
     |                                          |
     +-- adopt state; release acknowledged copies
     +-- queue unapplied messages; retire stale controls/responses
```

An inline handoff carries the completed result, pre-step state, open emission
state, pending obligations, selected input, unapplied events, and both addresses.
The child adopts the result without re-executing the step or reinjecting applied
input. The parent retains transferred events until settlement accounts for them.

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

`ask()` returns an eve-owned `Promise<ToolInputResponse>` backed by a request-ID
correlation in the owner's inbox. Awaiting, concurrent asks, and racing with
Workflow `sleep` remain supported. Hook-specific token, iterator, claim, and
disposal members are removed from this API.

Request sends are tracked: send failure rejects the ask. Early replies remain
buffered, answers are single-use, and concurrent asks cannot consume one
another's replies. Winning a sleep race does not withdraw the ask; it remains
answerable until answered or the authored body ends. Body settlement withdraws
remaining requests and cleans up waiters. Cancellation retains the existing
30-second grace period for authored code that ignores its abort signal.

Agent replies become `runtime.result` events. Workflow reports, requests, and
outcomes use the turn/task owner's inbox; task-local execution returns in memory.
Activity collectors retain their existing debounce and expiry behavior.
Application-authored `createHook` and `createWebhook` remain unchanged.

## Deployment cut

Ship the new tokens, envelopes, owner inputs, callback routing, and terminal
emission together as the `owner-inbox-v1` topology. New routes do not resume old
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
`turn.interrupted`, the `ask()` return type, and delivery/recovery limits.

## Verification

These are implementation checks, not results established by this proposal.

| Area                            | Required evidence                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small Workflow spike            | The pump observes persisted order through long steps, claims, sleeps, replay, and restart; abort reaches supported work; disposal and reader failure release waiters. Verify on Local, Vercel, and other supported Worlds, including configured Postgres. Confirm retry horizons and ambiguous-send behavior. |
| Structural inventory            | One operational inbox per receiving owner, zero inline turn hooks, no per-answer/cancel/report/reply hooks, and claims only for contested aliases and independent owners. Count lookup hooks separately; verify all eve-owned hooks omit metadata.                                                            |
| Turn semantics                  | Steer at natural completion keeps the turn ID without a terminal frame; interrupt/cancel precedence and state preservation hold; finalizer retries retain event identities.                                                                                                                                   |
| Ownership and recovery          | Claim losers never run; re-key and callbacks route correctly; handoff never repeats a step; normal settlement accounts for all input; missing reports and disabled session expiry cannot leave an owner waiting indefinitely.                                                                                 |
| Other traffic and compatibility | Concurrent asks, sleep races, tasks, subagents, authorization, and collectors work through their owner inboxes. Cover duplicate/stale input, bounds, pre-cut reset, newer ingress to older parents, and internal upgrades/rollback.                                                                           |
| Hosted performance              | Same-SDK paired measurements include ingress, finalization, supervision, replay, and multi-step/tool traffic across same- and cross-deployment cases. Report durable operations and state size alongside latency; regressions beyond the benchmark's acceptance budget block rollout.                         |

Use unit tests for reducers, Workflow-backed scenarios for scheduling and failure
boundaries, and deterministic fixture evals in CI for streamed behavior. Relevant
fixtures include `agent-workflow-tools`, `fixture-tasks`, and `agent-channels`.

Source baseline: eve `a6e72c470430e0cb807103c5448176034ec3c23d`, with
`@workflow/core@5.0.0-beta.47`. The current
[session inbox](../packages/eve/src/execution/session-command-inbox.ts),
[child turn](../packages/eve/src/execution/turn-workflow.ts),
[owner channels](../packages/eve/src/execution/tools/workflow/owner.ts), and
[task workflow](../packages/eve/src/execution/tasks/child/workflow.ts) establish
the inventory. [Inline turn control](../packages/eve/src/execution/inline-turn.ts)
and [harness emission](../packages/eve/src/harness/emission.ts) establish the
steering/finalization boundary. Metadata behavior is visible in
[eve ingress](../packages/eve/src/execution/wire/session-inbox-resume.ts) and
[Workflow's resume implementation](https://github.com/vercel/workflow/blob/7cc5c88a8bb2fad48353dd006c6ca1f28190ab46/packages/core/src/runtime/resume-hook.ts).
