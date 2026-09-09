---
issue: https://github.com/vercel/eve/issues/876
status: proposed
last_updated: "2026-09-09"
---

# Build keyed cells

## Outcome and decisions

Build keyed cells: stable identities that own state, serialized message
processing, and asynchronous effect dispatch. Use eve as the first consumer.
PostgreSQL and an owned Node.js worker fleet provide the infrastructure.
The platform owns admission, execution, persistence, recovery, and deployment
changes. No message broker is required.

This is **plan A**. It is independently sufficient to replace eve's workflow
runtime. [Plan B](./resumable-tasks-platform.md) adds resumable tasks to the same
foundation; do not implement a second scheduler or storage service for them.

The APIs, tables, module names, and configuration below are proposed work, not
existing eve functionality. The linked issue is the existing performance
tracking context, not approval of this architecture.

Read the [implementation appendix](./compute-spec/README.md) as part of this
plan. Its [TypeScript contracts](./compute-spec/contracts.ts) and
[PostgreSQL DDL](../packages/eve/src/compute/storage/migrations/0001_baseline.sql) are the concrete reference for names,
types, tables, and constraints. The appendix also specifies HTTP/IPC, transactional
algorithms, exact eve refactor boundaries, and the migration capture procedure.

| Decision           | v1 choice                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Application code   | Trusted, deployment-built TypeScript running on Node.js 24.                                                                                     |
| Isolation          | Separate application processes per project and deployment; platform services own database credentials. This is not a hostile-code sandbox.      |
| Persistence        | PostgreSQL primary in the same region as workers, with synchronous HA configured by the infrastructure operator.                                |
| Concurrency        | One committed state transition at a time per cell; different cells run concurrently.                                                            |
| Recovery           | Recover explicit state and pending work. Never replay historical user control flow.                                                             |
| Deployment changes | New code takes ownership between transitions after forward data migration.                                                                      |
| Initial migration  | Controlled maintenance and verified export/import, not automatic session resets.                                                                |
| Performance target | Warm ingress-to-execution-start p95 below 100 ms in-region; measure cold starts, failover, and external work separately.                        |
| Out of scope       | Active-active regions, custom consensus, arbitrary customer code, distributed transactions across external services, JavaScript heap snapshots. |

## 1. Read the existing integration points

Before implementing, read these files and their colocated tests:

- [`Runtime`](../packages/eve/src/channel/types.ts): preserve the signatures of
  `createSession`, `dispatchSession`, `dispatchContinuation`,
  `resolveContinuation`, `getEventStream`, and `getStreamTailIndex`.
- [`createWorkflowRuntime`](../packages/eve/src/execution/workflow-runtime.ts):
  identifies workflow-owned session IDs, aliases, streams, and activity collectors
  that the new runtime must replace.
- [`turnStep`](../packages/eve/src/execution/workflow-steps.ts) and
  [`createExecutionNodeStep`](../packages/eve/src/execution/node-step.ts):
  separate framework behavior from the Workflow step wrapper.
- [`HarnessSession`](../packages/eve/src/harness/types.ts) and
  [`applyTaskTransition`](../packages/eve/src/tasks/transitions.ts):
  reuse the existing serializable session representation and task rules.
- [`durable-session-store`](../packages/eve/src/execution/durable-session-store.ts)
  and [`context/serialize`](../packages/eve/src/context/serialize.ts):
  understand the current snapshot codec and migration requirements.

Do not import `workflow-runtime.ts` into the new backend to reuse a helper:
that would retain the dependency this project removes. Extract genuinely shared
helpers without changing their behavior.

## 2. Architecture and code ownership

```text
channel / client
      |
      v
platform API ---- durable admission ---- PostgreSQL
      |                                      ^
      | wake hint                            | fenced transactions
      v                                      |
cell worker ------ short transition ----------+
      |
      +---- committed effect ---- effect worker ---- model / tool / sandbox
      |                                  |
      +<------- durable completion ------+
      |
      +---- transactional outbox ---- another cell
```

Implement platform runtime code under `packages/eve/src/compute/`, with modules
for `protocol`, `storage`, `cells`, `effects`, `scheduler`, `worker`, `client`,
and `operations`. Export eve-owned definitions from a new `eve/compute` entry
point. Keep the eve adapter under `packages/eve/src/execution/`.
Use `apps/compute-platform` only for service bootstrapping, container definitions,
and deployment configuration; runtime behavior stays in the `eve` package.

Use the repository's existing Nitro HTTP stack for the service API. Wrap the
PostgreSQL driver behind `compute/storage`; no driver types enter public APIs.
Follow the existing compiled-dependency process for server-only dependencies
instead of adding a driver to every eve application's runtime dependency tree.
Use separate database roles for schema migration, platform runtime, and read-only
inspection. Application execution processes receive no database connection string.

An immutable deployment manifest maps definition paths to compiled module exports.
Names derive from paths, not redundant authored `name` fields. The gateway never
accepts a client-provided module URL, filesystem path, or worker destination.
Workers load only manifests and artifacts admitted by the deployment service.

### Service responsibilities

| Service           | Owns                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| API               | Authenticate, authorize the exact namespace/resource, validate input, commit admission, return receipts, stream persisted events. |
| Scheduler         | Claim runnable cells/effects, renew ownership, recover expired work, deliver timers and outgoing messages.                        |
| Worker supervisor | Load deployment processes, enforce concurrency/time limits, relay cancellation, terminate unhealthy processes.                    |
| Cell executor     | Run one synchronous transition and submit its proposed commit.                                                                    |
| Effect executor   | Run asynchronous I/O against an independently persisted operation identity.                                                       |
| Operations        | Deployment activation, data migrations, quarantine, inspection, maintenance, export/import, and retention.                        |

## 3. Define the public cell contract

Use a state-machine form, not an arbitrary long-running async cell method.
The cell transition cannot perform I/O. Its effect declarations are data.
Trusted authors must obey this contract; rejecting returned promises does not
prove that a synchronous handler has no side effects.

Implement the complete `CellDefinition`, `Transition`, `DeliveryContext`,
`EffectDefinition`, `EffectRequest`, `CellMessage`, `TimerRequest`, `ChildStart`,
and `DurableEvent` contracts in [contracts.ts](./compute-spec/contracts.ts).
Definitions supply state/message schemas and forward migrators. `receive`
receives the accepted delivery ID, sequence, timestamp, and protected origin;
this gives it the context needed to derive stable operation identities.

`defineCell` validates definitions. Effect requests refer to registered effect
definitions; they cannot override the definition's retry policy. Send, effect,
timer, child, and event requests carry stable local keys. Scope those keys as
specified in the appendix, rather than generating new identities during retry.
`terminal: true` closes the cell after its final transaction commits.

Expose client operations `send`, `readState`, `readReceipt`, and `readEvents`.
`send(address, message, { idempotencyKey })` returns a durable receipt with
`messageId` and a cell-local sequence after admission commits. It does not
wait for model execution. Polling a receipt is an inspection operation, not how
workers coordinate or wait for child results.

Use the appendix's exact HTTP routes under `/compute/v1/namespaces/:namespaceId` for cell messages,
state, receipts, events, deployment activation, and administrative operations.
Derive project access from authenticated identity. A namespace or cell ID in
the URL is not authorization. Return `409` for reuse of an idempotency key with
different content, `413` for oversized payloads, and `429` for admission limits.

## 4. Build the persistence contract first

All tables include `namespace_id`; all references and authorization queries
include it. Use database constraints, not application checks alone, for uniqueness.
Use UUIDs for newly allocated internal resource and delivery identities. Logical
effect/idempotency keys and imported public session/task IDs remain opaque
strings; do not cast legacy Workflow run IDs to UUIDs. Store sequence/revision
counters as PostgreSQL `bigint` and encode them as decimal strings on the HTTP
wire. Cell keys are strings with a unique `(namespace_id, definition_id, key)`.

| Table                            | Required data and constraints                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `namespaces` / `namespace_usage` | Desired deployment, epoch, admission mode, quotas, and separate locked usage accounting.                                                                           |
| `cells`                          | ID, definition/key, active/quarantined/terminal status, state bytes/version, revision, owner, lease epoch/expiry, adopted deployment, next message/event sequence. |
| `messages`                       | Cell ID, sequence, delivery ID, request hash, versioned payload, status, accepted time; unique cell/sequence and cell/delivery ID.                                 |
| `effects`                        | Owner cell, logical effect ID, input hash/version, definition, original deployment, policy, status, attempt, owner/lease epoch/expiry, result reference, deadline. |
| `outbox`                         | Stable delivery ID, source, destination, versioned payload, status, next attempt time.                                                                             |
| `timers`                         | Cell, timer ID, generation, deadline, message; unique cell/timer ID.                                                                                               |
| `events`                         | Cell, monotonic sequence, unique event ID, payload, source operation/attempt.                                                                                      |
| `history`                        | Session cell, history revision, appended model messages or compaction record.                                                                                      |
| `aliases`                        | Namespace/alias to cell ID and generation; alias uniqueness enforced in the database.                                                                              |
| `public_ids`                     | Namespace/kind/public ID to internal resource UUID; preserve imported session/task IDs without changing internal keys.                                             |
| `payloads`                       | Immutable, content-identified byte payloads for large inputs/results/history attachments.                                                                          |
| `deployments`                    | Approved artifact digest, definition manifests, schema versions, activation state.                                                                                 |
| `migration_batches`              | Namespace/batch ID, source inventory hash, per-resource import receipts, validation state, and cutover status.                                                     |

Store structured values through one versioned eve codec; do not rely on raw
`JSON.stringify` for values that currently contain typed arrays, dates, or maps.
Vendor and wrap the already-used `devalue` codec independently of `@workflow`,
with explicit tests for the rich types eve currently persists. Store files and
large binary values in `payloads` and carry references in hot records. Credentials
are resolved at execution time from secret references, not checkpointed.

Initial configurable safety limits: 256 KiB messages, 1 MiB cell state,
10,000 unprocessed messages per cell, and 100 events/sends/effects per transition.
Reject before admission or before committing an oversized transition; do not
partially apply it. Read APIs page at 100 records by default and at most 1,000.
Do not delete deduplication records for a live cell. A terminal cell retains
its receipts and dedupe records for 30 days, then becomes a tombstone that rejects
further delivery; deletion must not silently recreate the same identity.

### Admission transaction

1. Resolve or insert the cell, including its unique path-derived identity.
2. Lock the cell row. Look up the delivery/idempotency key.
3. Return the original receipt for matching content; reject mismatched content.
4. Allocate the next sequence and insert the message.
5. Commit before acknowledging or publishing a wake hint.

Concurrent sends are ordered by this transaction, not client clocks or HTTP
arrival observations. Alias resolution and admission occur in one transaction;
an alias rekey cannot redirect an already accepted message to another cell.

### Transition commit

1. Read the current state and lowest unprocessed message for the leased cell.
2. Run `receive` outside a database transaction, with a 50 ms CPU budget.
3. Begin a transaction and lock the namespace row `FOR SHARE`, then the cell.
   Check the owner, lease epoch, unexpired database-time lease, state revision,
   deployment epoch, and message.
4. Write state, mark the message consumed, allocate event sequences, and insert
   effects, outgoing messages, and timers in this same transaction.
5. Commit, then update the worker cache and publish wake hints.

If any check fails, discard the computed transition. A failed commit must not
publish stream events or start effects. Retry deadlocks or transient database
errors only around this side-effect-free transaction, with bounded retries.
A validation or handler error quarantines the cell at the offending sequence;
it must not silently skip that message and process later messages.

Use the appendix's complete lock order, including aliases and usage accounting.
Deployment activation takes an updating lock on the namespace
row. This prevents an epoch check from racing a deployment commit; an ordinary
unlocked read of the epoch is insufficient. Effect admission and resumable task
commits use the same barrier. Never hold the namespace lock while executing user code.

## 5. Implement scheduling, ownership, and recovery

Use row claims with `FOR UPDATE SKIP LOCKED` for scheduling independent runnable
cells and effects. Never hold a database transaction open while application
code or an external request runs. Cell ownership is a renewable lease, not an
open SQL transaction or a PostgreSQL advisory lock held across user work.

Use a 30-second lease renewed every 5 seconds, with all validity comparisons
against database time. Every ownership change increments a durable lease epoch.
All writes from executors carry that epoch. A resumed or partitioned old process
can still physically run, but it cannot commit under an expired ownership token.
Only downstream idempotency/reconciliation can control external effects from
such a process.

Use `LISTEN/NOTIFY` only as a low-latency wake hint containing resource IDs.
The database is the work inventory. Poll runnable work every 25 ms while busy
and every 250 ms while idle, and scan expired leases every second.
A dropped notification or scheduler restart must delay work, not lose it.
Keep a bounded state/artifact cache in warm workers; validate ownership and
revision on every commit.

Start with 16 concurrent cell activations and 32 effect executions per supervisor,
with the dedicated process-pool layout and resource limits in the appendix.
Process at most 32 messages from a cell before
yielding to other runnable cells. Backpressure must preserve the accepted-work
inventory. Scale workers from oldest-ready age and saturation, not CPU alone.

Deliver an outbox row by inserting the destination message using its stable
delivery ID. After the destination admission commits, mark the source delivery
complete. A crash between those commits causes another send with the same ID.
It does not cause a second destination transition. Timers use the same path;
replacement or cancellation increments the timer generation so stale deliveries
are no-ops. Scheduled work remains in PostgreSQL while no worker is running.

## 6. Separate effects from cell transitions

An effect is a registered async function with versioned input. Its logical ID
is chosen by the application, for example a persisted tool call ID. Persist an
input hash and reject reuse of that ID with different input.

Before making an external call, commit the attempt as running. After the call,
commit its result and an outgoing completion message together. The cell's
transition consumes the completion later. The cell never waits synchronously
for the effect, so cancellation and steering can advance its state.

Implement two explicit retry policies:

- `idempotent`: the author declares the operation repeatable or supplies a
  downstream-supported idempotency key. Retry transient failures up to five
  attempts with exponential backoff and jitter. Preserve the key and input.
- `manual`: default for tools whose effect cannot safely be repeated. If a
  running attempt loses its owner or times out without a known result, mark it
  `indeterminate`; do not automatically execute it again. Expose an operator
  action to record a verified outcome or explicitly authorize another attempt.

Model requests may opt into retries with the explicit understanding that a
provider can charge for an interrupted attempt. This is not exactly-once billing.
Use a 120-second default end-to-end effect deadline from registration and a
configurable v1 ceiling of 15 minutes, including queue time and retries.
Longer work must checkpoint, use a remote durable service with a
status/reconciliation API, or fail configuration validation.

Cancellation commits a new logical turn/task generation and marks affected
effects for cancellation. Forward `AbortSignal` as best effort. Retain late
outcomes for inspection but never let them update a replacement turn. Distinguish
this logical generation from a worker lease epoch: worker recovery alone must
not invalidate a legitimate operation result.

## 7. Preserve streaming, deployment, and operations

**Streaming:** use the durable `events` sequence as the reconnect cursor. Append
before forwarding bytes to clients. Batch model deltas for at most 20 ms or
32 KiB, whichever comes first. Each append verifies the effect attempt, lease,
and active turn generation; retries use stable append IDs. Flush a final batch
before committing terminal state. Already persisted output from an interrupted
attempt remains visible, matching eve's current retry behavior; canonical model
history contains only the accepted completed result.

**Upgrades:** publish an immutable deployment, then advance the namespace's
desired deployment epoch. This blocks new old-version transition/effect
admissions. Existing transitions either committed before the epoch change or
must discard their result. Already-admitted effects retain their original
definition/input/deadline, including permitted retries, and may record outcomes
after a deployment change. Retain their artifacts for that bounded lifetime.

At a cell's next activation, migrate its state and adopt the new deployment in
one revision-checked transaction. Migrate each pending message just before its
consumption, retaining its original payload/hash. Do not hold a transaction open
while transforming an entire inbox. A deployment must declare decoders for
all retained message versions. Migrate consumed result data explicitly; never
rewrite an already-admitted effect's immutable input or idempotency fingerprint.

Migration failure quarantines the resource with its old data intact. Do not
start the old handler as a fallback. Retire an old deployment only after there
are no remaining owners or operations requiring its artifact. Remove old data
transforms after an inventory proves all live and pending data was migrated.
Rollback means a tested data-compatible deployment or restore/reconciliation,
not silently pointing incompatible code at newer state.

**Operations:** provide authenticated inspect, quarantine, resume, cancel,
reconcile-effect, pause-namespace, and export commands. Every mutation needs an
expected revision and an audit record. Parameterize SQL, bound requests, and
validate configured outbound callback destinations. Never return stack traces
or log secrets, full prompts, or tokens by default.

Collect admission latency, oldest-ready age, transition duration, lease losses,
stale-write rejections, operation retries/indeterminate outcomes, outbox age,
stream lag, migration failures, and database commit latency. Trace by cell,
message, operation, and attempt IDs without high-cardinality metric labels.
On database unavailability, fail closed: no durable acceptance or unfenced writes.
The HA runbook must fence the former primary and preserve acknowledged commits
before resuming traffic; an asynchronous replica is not an equivalent failover
target for this durability contract.

Admission must also enforce per-namespace aggregate quotas, including payload
storage. Initial limits are 16 MiB per payload, 10 GiB per namespace, and a
256 MiB worker cache. Make these configuration values with explicit rejection,
not unbounded defaults. Use the appendix's reference-tracing procedure for garbage
collection; never remove input/result bytes for unresolved work.

## 8. Replace eve's workflow runtime

Implement `createCellRuntime` against the existing `Runtime` interface.
Use a session cell for session identity, pending deliveries, turn state, and
history references; use a task cell for independently continuing background
tasks. Subagent sessions are ordinary session cells with explicit parent
addresses. Use the alias table for channel continuation tokens and preserve the
public session IDs during migration.

Extract reusable preparation and result-adoption logic from `turnStep`; retain
authentication, authorization, provider lifecycle, instrumentation, quotas,
compaction, and model-history behavior. Add an execution driver interface rather
than importing Workflow's hooks or streams. Move Workflow-specific attributes
behind the existing instrumentation boundary.

Do not run an entire model/tool loop as one retried effect. Split at the model
result and each individual tool invocation. Persist the model's tool call IDs
before dispatching tools. Reuse existing harness policy and task transitions;
change the minimum necessary harness execution boundaries to expose those
checkpoints. A completed tool result must never be lost because a later tool or
model call fails.

Represent approval, authorization, sleep, child completion, and human input as
explicit pending records with correlation IDs. Accept replies through normal
cell messages after existing authorization checks. The pending record is
committed before publishing the request. Resolve child completion through
messages, not polling or a blocked parent worker.

For plan A alone, introduce `defineCellTool` in `eve/compute`: existing tool
metadata plus a keyed cell definition whose messages include invoke, input,
cancel, and effect completion. Completion produces the existing tool result;
progress produces the existing task update. Replace authored
`defineWorkflowTool` examples with these explicit transitions. Do not claim
source compatibility with suspended async workflow functions.

Preserve programmable delegation with the appendix's `Program` tool and
`experimental_program` definition. Its bounded pure evaluations return explicit
state and child-call batches; cells persist those decisions before dispatch.
This replaces the old suspended-source API without removing composition,
fan-out, branching, loops, or aggregation. Ordinary tools and subagent tasks
remain available. Do not retain an embedded replay engine as a hidden fallback.

## 9. Migrate existing sessions without guessing state

Perform migration first on copied fixture data, then on an operator-approved
namespace during maintenance:

1. Inventory session cohorts, driver capabilities, active tasks, pending input,
   authorization callbacks, external effects, aliases, histories, and cursors.
2. Implement the appendix's `cursor-v1` read-only exporter, verified against exact
   source artifact digests. Capture authoritative cursor/driver/task state at the
   listed ownership points. Never choose the last stream chunk or step result
   heuristically. Unknown cohorts return `UNSUPPORTED_EXPORT`.
3. Pause legacy ingress. Durably stage new deliveries and callbacks in the new
   admission store with original dedupe identities. Ask active work to reach a
   supported boundary using existing control APIs; reconcile unknown effects.
4. Drain arbitrary suspended authored workflows to completion or an explicitly
   supported exportable state. Establish the source write fences and frozen
   journal frontiers described in the appendix before extraction. If the source
   adapter cannot prove late writes are fenced, the namespace cannot cut over.
5. Import using stable session/task IDs and a unique migration batch ID.
   Import each resource with an atomic receipt and rebuild aliases, pending
   waits, histories, operation identities, and stream positions. Keep the target
   namespace frozen until all resource receipts and graph references validate.
   Reimporting the batch is a no-op after content verification.
6. Compare record counts, hashes, pending ownership, permissions, and history/
   stream cursors. Exercise a copied canary in an isolated test namespace with
   external effects stubbed; keep the production target frozen until activation.
7. Change routing once per namespace, release staged messages in their accepted
   order, and prevent old workflow execution from accepting further work.
8. Keep only a bounded, authenticated callback-address relay when external
   issuers still hold old URLs. It maps stored old tokens to new pending records,
   not to an old workflow. Reissue callbacks that cannot be relayed. Retire each
   mapping at its recorded expiry or settlement.

Before committing source write fences, rollback can release staged ingress back
to the old namespace. Afterwards, keep ingress staged and complete or repair the
import; a terminally fenced source run cannot simply be unpaused. After any new
external effect executes, recovery requires reconciliation or forward repair.
Never resume both runtimes on the same work.
No automated export of arbitrary JavaScript locals is part of this plan.

## 10. Implementation sequence and acceptance

Implement these increments in order. Each increment needs its tests before the
next depends on it. The commit protocol, effect policy, and migration gates need
senior review; a junior engineer should not weaken them to make a test pass.

| Increment | Deliverable                                                                                   | Acceptance gate                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1        | Public definitions, codec, schema migrations, storage adapter, local PostgreSQL/worker setup. | Rich values round-trip; constraints reject duplicate/conflicting identities; migrations work on an empty and previous-version database.                    |
| A2        | Admission, synchronous transitions, receipts, fenced commits.                                 | 1,000 concurrent sends produce one ordered application per unique ID; injected pre/post-commit crashes lose no accepted message.                           |
| A3        | Scheduler, supervisor, leases, takeover, bounded caches.                                      | Kill or partition an owner; another resumes after lease expiry; restoring the old process produces rejected stale commits. Lost notifications still drain. |
| A4        | Effects, timers, outgoing delivery, cancellation and reconciliation.                          | Duplicate completion/delivery is harmless; an uncertain manual effect never automatically reruns; timers survive zero workers.                             |
| A5        | Durable streams/history, deployment adoption, operators and quotas.                           | Reconnect without gaps; stale writers cannot append; schema failure quarantines; a busy cell cannot starve unrelated keys.                                 |
| A6        | `createCellRuntime`, per-model/per-tool boundaries, tasks, input/auth waits, cell tools.      | Existing channel and deterministic agent behavior suites pass against the new backend, with no Workflow import in its dependency graph.                    |
| A7        | Export/import tooling, canary maintenance, callback relay, rollback rehearsals.               | Every imported namespace passes the migration checks above; unsupported sessions block rather than disappear.                                              |
| A8        | Performance/soak/failover qualification and dependency removal.                               | Meets the release criteria below; old driver, hooks, worlds, transforms, and runtime fallbacks are absent.                                                 |

Use unit tests for reducers, codecs, validation, and retry decisions; in-memory
integration tests for module contracts; scenario tests for PostgreSQL, worker
processes, HTTP, and crash injection. Add a dedicated scenario configuration for
the platform. Use fixture-owned CI evals for eve behavior; provision the platform
in CI infrastructure, never start external services from an eval.

Port the relevant cases from `agent-basic-runtime`, `agent-cancellation`,
`agent-tools-hitl`, `fixture-tasks`, `agent-session-timeout`, `agent-channels`,
and the deterministic performance fixture. Include namespace isolation, forged
resource IDs, stale approvals, out-of-order child results, alias races, and
cancel/reset while a model or tool is executing.

### Release criteria

- Warm p95 from gateway receipt to model/effect invocation is below 100 ms at
  100 messages/second spread across 100 cells for 30 minutes, with a mock model.
  Include durable admission, scheduling, transition, and required effect writes.
- Report warm/cold p50/p95/p99, throughput, database commits per operation, and
  independent cell/history-depth sweeps. Real provider time is separate.
  With a healthy database and available worker capacity, ownership takeover has
  a separate target of at most 35 seconds after worker loss. Manual effect
  reconciliation and database outage time are reported separately.
- Run a 24-hour soak with periodic worker termination, lost notifications, and
  scheduled database failover. Zero lost accepted messages and zero accepted
  stale commits are mandatory; investigate every unexplained hang.
- Preserve cancellation, authorization, pending tasks, session limits, alias
  semantics, and ordered reconnect behavior. Do not buy latency by deleting
  required durability writes.
- Remove `@workflow` runtime/build dependencies, world configuration, generated
  workflow registrations, old drivers, and compatibility encoders after cutover.
  Replace local development with the same PostgreSQL/worker protocol, not a
  separate correctness model.
- Update public execution/deployment/tool docs and examples in the implementation
  PRs; add a minor changeset for breaking public APIs. Update affected invariants
  by deleting obsolete enforcement, never by expanding violation baselines.

This document records a design and test targets. It does not claim that the
platform, performance measurements, or migration tooling already exist.
