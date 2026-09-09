---
issue: https://github.com/vercel/eve/issues/876
status: proposed
last_updated: "2026-09-09"
---

# Implementation contracts for keyed cells and resumable tasks

Read this appendix with the [keyed cells plan](../keyed-cells-platform.md) and
[resumable tasks plan](../resumable-tasks-platform.md). It supplies their shared
implementation decisions. The files here are reference specifications and tests,
not a platform implementation or new published APIs.

## Reference files and implementation order

- [contracts.ts](./contracts.ts) is the complete interface reference, including
  values, errors, delivery origins, effects, waits, IPC, deployment manifests,
  the turn driver, programs, and migration bundles.
- [schema.sql](./schema.sql) is the target v1 DDL, including secondary indexes,
  foreign keys, deduplication constraints, and ownership tuples.
- [schema.test.sql](./schema.test.sql) exercises selected database constraints
  and transaction rollback. It is not a concurrency or failover test.
- [example.ts](./example.ts) is a complete resumable-task definition checked
  against the contracts. [example.test.mjs](./example.test.mjs) exercises its
  checkpoint recovery and validation with an in-memory effect ledger.
- [tsconfig.json](./tsconfig.json) checks the reference interfaces independently
  of the rest of the workspace.

Target PostgreSQL 17 and Node.js 24 for v1 qualification. Use the workspace's
TypeScript version for production code. The reference checks may also run with
a locally available TypeScript compiler supporting `NodeNext`.

Install the baseline schema through a migration runner that records the file
checksum in `compute.schema_migrations`. Subsequent database changes are numbered,
forward-only migrations. The baseline intentionally fails if `compute` already
exists; do not make production schema upgrades by rerunning it.

Implement the shared storage functions before their HTTP/IPC adapters. Do not
copy the reference types into multiple packages: move them into the owning eve
modules during A1/B1 and update this appendix's links. Use the SQL file as the
migration source, not as an alternative runtime implementation.

## Values, validation, and identity

`WireValue.data` is the opaque string produced by `eve-value-v1`. Its initial
implementation wraps vendored `devalue`, with tested codecs for the rich values
already persisted by eve. It cannot contain live functions, streams, model
instances, credentials, or arbitrary prototypes. Schema versions belong to
definition inputs/state/results, not to the transport codec.

`ValueSchema<T>` is the eve-owned validation interface. The gateway validates
wire envelopes, registered versions, and size limits before admission. The runner's
platform wrapper validates decoded authored input before calling the handler or
effect, state/checkpoints before commit, and effect output before recording
success. The gateway does not load authored validator functions. An accepted
receipt is durable admission, not a promise that business-schema validation passes.
Apply the declared schema even when no migration is needed.
Reject unknown fields in platform envelopes, unknown versions, invalid
UUIDs, counters outside `[0, 2^63-1]`, and dates without an explicit UTC offset.
Untrusted schema exceptions become `INVALID_INPUT`, without a stack trace.

Definition IDs are normalized relative paths with no leading slash, `..`, URL,
or empty segment. Local keys are 1-256 UTF-8 bytes. The database permits longer
composed keys, up to 512 bytes. Client namespaces are established when constructing
the SDK client and authorized again by the server.

Define idempotency equality on the stored request representation, not fuzzy
semantic equality. Compute SHA-256 over a fixed-order JSON array containing
operation, resource scope, definition/version fields, and the exact codec string.
The SDK encodes once and retains the bytes on transport retry. Reusing a key with
another encoding or different input returns `IDEMPOTENCY_CONFLICT`; it never
starts a second operation.

For cell transitions, compose declared effect/send/event keys with the accepted
`deliveryId`; retries of the same message therefore produce the same identities.
For resumable tasks, effect and child keys are scoped to the task resource and
must identify the logical operation across checkpoint recovery. Do not add an
attempt number to an external idempotency key. Persist the initial IDs; do not
recalculate them using a newer UUID/hash algorithm during recovery.

The platform assigns `DeliveryContext.origin`. External callers cannot supply
it. Validate framework completion messages using the system schema and verify
their operation/generation before passing them to a definition; validate ordinary
messages using the authored message schema. A user message with
`kind: "effect_result"` is not an authenticated effect completion.

## HTTP and authentication

The base path is `/compute/v1/namespaces/:namespaceId`. Requests and responses
are UTF-8 JSON, except event streams, which use `application/x-ndjson`.
The body types below are defined in `contracts.ts`.

| Method and relative path                | Input                                                     | Success                                                                                                    |
| --------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /`                                 | None.                                                     | Namespace ID, epoch, mode, desired deployment, logical used bytes, and quota.                              |
| `POST /cells:send`                      | `SendRequest`                                             | `202 MessageReceipt`, including duplicates with the same body.                                             |
| `GET /cells/:cellId`                    | None.                                                     | `200 CellView`.                                                                                            |
| `GET /messages/:messageId`              | None.                                                     | `200 MessageReceipt`.                                                                                      |
| `GET /cells/:cellId/events`             | `after` decimal sequence, `limit`, `follow`.              | NDJSON `EventRecord` values in sequence order.                                                             |
| `POST /resumable-tasks`                 | `StartRequest`.                                           | `202 StartReceipt`.                                                                                        |
| `GET /resumable-tasks/:taskId`          | None.                                                     | `200 TaskView`.                                                                                            |
| `POST /resumable-tasks/:taskId/signals` | `SignalRequest`.                                          | `202 SignalReceipt`.                                                                                       |
| `POST /resumable-tasks/:taskId/cancel`  | `RevisionCommand`.                                        | `200 TaskView`; cancellation after any terminal outcome is a no-op.                                        |
| `POST /effects/:effectId/reconcile`     | `EffectReconciliation`.                                   | `200` with effect ID, status, and revision.                                                                |
| `POST /cells/:cellId/resume`            | `RevisionCommand`.                                        | `200 CellView`; retries a quarantined head under a valid deployment, without editing the accepted message. |
| `POST /deployments`                     | `DeploymentManifest`.                                     | `201` with registered digest, or `200` for an identical registration.                                      |
| `POST /deployments/activate`            | `ActivateRequest`.                                        | `200` with deployment and new epoch.                                                                       |
| `POST /admission`                       | `RevisionCommand` plus `mode: open \| staging \| frozen`. | `200` with mode and namespace epoch.                                                                       |

Event sequence starts at 1; `after=0` reads the first event. Default `limit=100`,
maximum 1,000. `follow=false` returns a finite page; `follow=true` first catches
up then follows persisted appends. Stop each response page at 16 MiB. A retained
cursor gap returns `409` with `REVISION_CONFLICT` and the earliest available
sequence before streaming starts; do not silently skip missing events.

Translate eve's existing zero-based `startIndex` in the adapter. With `N` retained
events, use `after=startIndex` for nonnegative indexes, or
`after=max(0, N + startIndex)` for negative indexes. `getStreamTailIndex` returns
`N-1`, including `-1` when empty. Do not expose internal bigint counters as
unchecked JavaScript numbers.

Return `{ error: Failure }` for errors: 400 invalid input, 401 unauthenticated,
403 forbidden, 404 unknown resource, 409 identity/revision/stale-execution conflicts,
413 oversized data, 429 quotas, 503 unavailable deployment/database, and 500
unexpected faults with an incident ID. `MIGRATION_REQUIRED` is a 409 with no
automatic fallback. Preserve the original receipt for retries of accepted work
even if the resource has since become terminal.

For trusted-project v1, use 32-byte random bearer credentials. Mount a read-only
server access file containing credential hashes, principal IDs, namespace IDs,
and permissions: `send`, `read`, `operate`, or `deploy`. Store the raw credential
only in the client's secret environment. Require TLS in production. Do not add
an OAuth service, accept a role from the request, or trust public forwarding
headers. eve continues to apply end-user/session authorization independently.
Application processes do not get administrator credentials or database access.

## Worker deployment and IPC

Ship three roles from the same owned code: HTTP gateway, scheduler/supervisor,
and application runner. In v1 the operator deploys immutable application images;
building a public image-upload or container-orchestration service is not required.
The gateway never downloads or executes code from a request.

The build emits a `DeploymentManifest` and a module map inside the application
image. Only relative paths inside that image are valid module entries. Register
the digest and manifest, start supervisors for that image, and wait for workers
to report the same manifest hash and protocol version. Activation fails with 503
if the target has no ready worker. A deployment digest is immutable; registration
with changed contents is a conflict.

Use Node's `child_process.fork` IPC with advanced serialization inside the trusted
container. `RunnerToSupervisor` and `SupervisorToRunner` specify all messages.
Treat decoded IPC as untrusted data anyway: validate it and match the assignment,
namespace, resource, epoch, generation, and deployment to the supervisor's own
assignment record. A child cannot select another resource by changing its token.
Do not expose this IPC protocol as a public HTTP endpoint.

Maintain separate warm pools for cell transitions, effect calls, and resumable
execution slices. One runner process holds one assignment at a time; never kill
a process hosting unrelated assignments to enforce a slice timeout. Cache module
imports in idle runners, not durable application locals. Return a process to the
pool only after its previous assignment has settled and asynchronous callbacks
have been cancelled; otherwise terminate it.

The supervisor owns database pools and lease renewal. The application runner sends
`alive` every 5 seconds; after 15 seconds without a response the supervisor stops
renewing and terminates the process. The scheduler recovers through the lease
rules below. Separate effect slots from parked parent slots so parents cannot
consume every slot needed by their children/effects.

Set cell/effect/resumable pool limits explicitly per supervisor. Initial values
are 16/32/16, with at most two idle warm processes per pool and 128 MiB idle heap
per runner. Set a 16 GiB supervisor-container memory limit for the qualification
environment; lower-concurrency deployments may use less. Stop admission to local
pools on memory pressure, without deleting accepted database work.

Every durable IPC command includes a unique request ID, a consecutive
assignment-local command sequence starting at 1, and the expected state/checkpoint
revision. Store its response in `execution_commands` in the same transaction as
the mutation. Retrying the same command returns its recorded response; a changed
body under that request/sequence conflicts. A sequence gap is rejected rather
than reordered. When a recorded response precedes subsequent lease loss, the
retry may acknowledge that historical commit but must not grant a new lease.

## Storage algorithms

Use `READ COMMITTED` with explicit locks; do not mix optimistic reads with an
assumed serializable transaction. Use `clock_timestamp()` after obtaining row
locks for lease comparisons. `now()` reflects transaction start and is not the
lease clock for a transaction that waited on a lock.

Lock order is namespace `FOR SHARE`, alias rows sorted by text when applicable,
resource rows sorted by UUID, namespace usage accounting, then dependent rows.
Deployment/admission changes lock the namespace `FOR UPDATE`. Never upgrade a
namespace share lock to update usage: account storage in `namespace_usage`.
Provision `namespace_usage` together with the namespace. Charge new payload
bytes plus 1 KiB per new durable row in one checked increment in the mutation
transaction; shared payload references are not charged twice. This is a logical
quota, not an estimate of physical PostgreSQL/index/WAL size. Monitor physical
database capacity separately. Cleanup subtracts the same recorded byte/row costs.

### Admission and aliases

`admitMessage` creates an uninitialized cell row at revision 0 when necessary.
Its state reference is null until the first transition validates `initial()`.
Insert with `ON CONFLICT DO NOTHING`, then select the natural-key row `FOR UPDATE`.
Check the delivery key before allocating sequence or payload storage. Allocate
`next_message_seq`, insert the message and its server-assigned origin, and set
`ready_at` if it is earlier than the current value. All changes commit together.
An identical retry after lost response returns the original message row.

An alias row can contain `cell_id=NULL` as a reservation/tombstone. Resolve or
rekey aliases by creating the row if missing and locking it before its cell.
Atomic SQL transactions alone do not protect an unlocked alias read. Rekey locks
both old and new aliases in lexical order and increments the generation.
An occupied destination alias is a conflict, never an overwrite.

### Claim, renew, and commit

`claimCell(namespace, worker, deployment)` locks the namespace for share, checks
worker readiness, then selects the earliest eligible row:

```sql
SELECT cell_id
FROM compute.cells
WHERE namespace_id = $1
  AND status = 'active'
  AND ready_at <= clock_timestamp()
  AND (owner_id IS NULL OR lease_until <= clock_timestamp())
ORDER BY ready_at, cell_id
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

For `kind='resumable_task'`, additionally require the task to be ready or to have
lost an execution owner without an unresolved dependency. A resource requiring
migration can only be claimed by a worker for the desired deployment. Perform
schema preparation outside locks; adopt migrated state by revision-checked commit.

Claims permit admission mode `open` or `staging`. `staging` holds new external
ingress but lets already-accepted work, including its internal dependencies,
advance to a supported boundary. `frozen` allows only administrative imports,
inspection, and explicit reconciliation, not new application assignments.
Creating a frozen namespace does not by itself prove old external executions
were stopped; migration requires the separate source write-fence proof.

Use a `mode: "migrate"` assignment for schema preparation. The wrapper calls only
the new definition's validators/migrators; it exposes no execution context or
effect API. `adopt_migration` checks the captured revision, lease, old data
version, and current desired digest before atomically replacing the relevant
state/input references and version fields. Its reply has `control: "release"`.
The runner exits that assignment; a fresh execute assignment sees only adopted
data. Ordinary replies use `control: "continue"`.

Assign a new UUID, increment `lease_epoch`, and set
`lease_until=clock_timestamp()+interval '30 seconds'` in the claiming transaction.
Set `ready_at=NULL` while owned; a later admission may set it again. Renewal uses
an update guarded by namespace, resource, worker, assignment, epoch, and
`lease_until > clock_timestamp()`. Zero updated rows means ownership was lost;
do not reacquire under the same epoch.

`commitTransition` locks and verifies the cell and its exact head message:
`message.sequence = processed_seq + 1`. Check the deployment barrier and current
revision, validate output, then write the new state reference, advance
`processed_seq`, mark the message applied, and stage effects/children/outbox/
timers/events. Record the IPC response in that same transaction. A lost commit
response is resolved through that receipt, not by rerunning external work.

After a batch of at most 32 transitions, release ownership and preserve/set
`ready_at` when another pending message exists. The one-second repair scan must
also mark expired owned cells runnable from their durable message/dependency
inventory. Merely clearing an expired lease is insufficient because `ready_at`
may still be null.

`rejectHead` quarantines the cell and records a sanitized reason without advancing
`processed_seq`. `resume` can retry the same immutable head after a deployment or
operator repair. Closing the cell marks every remaining receipt cancelled.
No automatic poison-message skipping or identity reuse is allowed.

### Effects and outgoing delivery

`registerEffect` uses the owning resource lock and a unique resource/effect key.
Verify an existing input hash before returning it. Freeze the registered
definition, retry policy, input, output version, and artifact digest.
Applications cannot weaken a definition's retry policy in a request.

`claimEffect` locks its owner cell before the effect row, increments attempt and
lease epoch, inserts `effect_attempts`, and commits before starting I/O.
Its lease renews independently of its parent's execution. The operation deadline
is established at registration and covers queue time and retries; recovery
cannot extend it indefinitely.

Select only effects for the worker's immutable deployment. A draining worker
may claim already-admitted effects for that deployment, but cannot claim new
cell/task executions. Retain old effect workers until their admitted work settles
or reaches its deadline. Do not strand old ready effects by routing every claim
to the namespace's latest deployment.

`finishEffect` verifies the effect lease and immutable artifact, records the
result/output version, closes the attempt, and inserts its completion outbox
message in one transaction. It may commit under the original admitted artifact
after a namespace deployment change. A deployment change alone is not a reason
to discard a real external result. Cancellation/turn-generation mismatch prevents
session adoption; retain the known outcome for reconciliation.

After an uncertain running attempt, manual effects become indeterminate.
Idempotent effects enter retry wait with the same operation/idempotency key.
Use five total attempts, delays of 1, 2, 4, and 8 seconds with full jitter, bounded
by the original deadline. An explicit permanent error fails immediately.
Administrative retry of a manual effect requires evidence and creates a fresh
attempt after a verified freeze of the former executor; it does not assert
exactly-once external behavior.

Set `authorized_attempt=attempt_count+1` and a new bounded deadline in that
administrative transaction. The next claim consumes this authorization once.
The automatic retry limit still remains one for a manual effect; do not turn
manual reconciliation into a permanent retry-policy override.

`deliverOutbox` claims a row with a 30-second claim ID, commits that claim, then
calls normal admission with `delivery_id` as the destination dedupe identity.
Mark it sent only after admission succeeds. A recovery scan returns expired
claims to ready. Transient delivery errors use the same bounded backoff but keep
the durable row; after five consecutive errors mark it blocked and alert an
operator, rather than losing it. v1 outgoing cell messages stay in one namespace;
cross-project agent calls use eve's authenticated remote-agent effect.

Timer delivery stages a message with `(timer key, generation)` as its identity.
Before application delivery, verify the protected timer origin against the timer
row. A replaced/cancelled generation is acknowledged as obsolete without calling
the handler. Duplicate deliveries of the current generation use normal dedupe.

### Streams, history, and cleanup

`appendEvents` locks the target cell and verifies its source effect/assignment
and logical generation. Allocate consecutive sequences in the cell row and
deduplicate by an append key containing operation, attempt, and chunk index.
The same append key with other bytes conflicts. Return only committed events
to subscribers. Subscribe before querying the catch-up page and query again
after every wake or fallback poll; notifications do not carry authoritative data.

Append history by a stable commit key and monotonic revision. Compaction and
clear create explicit history records instead of silently rewriting earlier
rows. Checkpoint references identify the history frontier to hydrate.

Retention never deletes rows needed by pending work or live deduplication.
For v1, use reference tracing during maintenance, not a second mutable refcount:
mark payload IDs reachable from all declared foreign keys and migration manifests,
then delete only unmarked payloads older than 24 hours in 1,000-row batches.
The storage adapter must register any reference-bearing JSON field with this
tracer. Retire terminal resources and their dependent rows in foreign-key order
after 30 days, leaving a natural/public-identity tombstone.

## Exact eve refactor boundaries

Implement the `TurnDriver`, `TurnCursor`, and `TurnEvent` types in `contracts.ts`.
`reduce` is pure. It changes a phase and returns operations; it does not call
models, user tools, provider hooks, or filesystem adapters. Both runtime adapters
consume the same decisions.

| Owning module to implement/extract | Existing source boundary                                                  | Required result                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `execution/turn-driver.ts`         | `workflow-steps.ts` action selection plus harness result handling.        | Closed phase/event reducer and generation checks.                                         |
| `execution/turn-prepare.ts`        | Context hydration and delivery handling before `createExecutionNodeStep`. | Versioned prepared-context/history references; no model call.                             |
| `harness/model-invocation.ts`      | `runSingleModelCall` and `executeModelCall` in `harness/tool-loop.ts`.    | Exactly one provider call with local tools advertised without execute functions.          |
| `harness/tool-invocation.ts`       | Tool-set execute wrappers and `harness/execute-tool.ts` definitions.      | Execute one persisted call ID after input/approval/authorization checks.                  |
| `harness/turn-result.ts`           | `handleStepResult` and history/result helpers in `harness/tool-loop.ts`.  | Pure adoption of an accepted model/tool result.                                           |
| `execution/turn-finalize.ts`       | Current finalization, callbacks, instrumentation, and usage adoption.     | Idempotent terminal effects and session result proposal.                                  |
| `execution/compute-runtime.ts`     | `createWorkflowRuntime` interface implementation.                         | Shared routing/streams/aliases; thin cell and resumable adapters select execution policy. |

Register owned effect definitions `eve/prepare`, `eve/model`, `eve/tool`,
`eve/compact`, and `eve/finalize`. They are fixed framework definitions in the
deployment manifest, not user-supplied module paths. Preparation and finalization
can call authored hooks; their outputs and context deltas are durable. Treat
unclassified authored hook side effects as manual, and document the retry contract.
Do not assume a provider hook is pure merely because its name is `prepare`.

Decode a committed effect result to `TurnEffectValue` before invoking the pure
reducer. The result includes the small control projection the reducer needs and
references to larger snapshots; do not make the reducer fetch a result reference.
Store accepted input and its delivery identity before dispatching preparation.

| Current phase and accepted event | Decision                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| New input                        | Store its reference and stage `eve/prepare` for this turn generation.                                                                                |
| `prepare` result                 | Adopt snapshot references and follow its closed `next` field: model, compaction, approved tools, wait, or finalization.                              |
| `compact` result                 | Adopt the compacted snapshot and stage the model operation with the retained prepared-input reference.                                               |
| `model` result                   | Adopt the committed response/call IDs; dispatch authorized tools, register the explicit wait, prepare another step, or finalize according to `next`. |
| Individual `tools` result        | Fill the matching pending call entry once; when all settle, increment the step and run preparation with results in original call order.              |
| Authorized wait answer           | Retain the answer and run preparation. It may return `next=tools` for the original approved calls without invoking another model first.              |
| `finalize` result                | Adopt final references and emit the session result; mark the turn settled.                                                                           |
| Cancellation or stale generation | Cancel owned work and preserve accepted input through the existing cancellation-history helper; never adopt a late result into the replacement turn. |

Preparation merges per-tool context deltas in original tool-call order.
For authored scalar keys, later calls win. For framework-owned task/agent/usage
state, call the existing merge/projection helpers; never replace the whole
framework state with one tool's older snapshot. Document this ordering and cover
it with conflicting-update tests.

The current `ToolLoopAgent` setup supplies local execute functions and can execute
tools within a provider step. Remove those local executors from the model-only
effect. Persist the complete provider result and call IDs first; dispatch tools
as separate effects afterwards. Keep schemas and approval metadata in the model
request. Provider-executed tools remain inside the model operation, with a retry
policy appropriate to that provider's external effects.

Persisted `sessionRef` values exclude full conversation history and compiled
artifacts. `historyRef` identifies a history-frontier manifest; `contextRef`
contains serializable context and definition references, not hydrated closures.
Hydrate a complete `HarnessSession` inside an execution process when needed.
Reuse unchanged payload references; do not recreate a full-history snapshot at
every phase and reintroduce quadratic storage growth.

At `model` completion, preserve its ordered tool-call list and advance to `tools`.
Register approved tool calls as one batch. Authorization/approval requirements
create waits before execution. Adopt completed tool results in the original
call order, even if they finish out of order, then advance the model step counter.
Rejected/stale answers cannot authorize a tool. Use existing task transitions and
history normalization rather than adding a second policy implementation.

Do not serialize `StepNext` function references into `TurnCursor`; map them to
the closed phases in the contract. Reconstruct live callbacks through current
definition paths and versioned descriptors. Preserve dynamic instructions/models/
tools/connections, memory lifecycle, compaction, channel delivery, quotas,
subagent ownership, sandbox references, and instrumentation at their existing
logical boundaries. Add one focused regression test for each during A6/B6.

Configure the thin runtime client through live host bindings:
`EVE_COMPUTE_ENDPOINT`, `EVE_COMPUTE_NAMESPACE`, and `EVE_COMPUTE_TOKEN`.
Never persist the token in session context. `createCellRuntime` and
`createResumableTaskRuntime` select the executor for newly created sessions.
Persist that choice in the session cell's state; subsequent dispatch reads the
stored choice, rather than switching an existing turn when a host default changes.
Changing an existing session's executor uses plan B's quiescent migration.
Once B7 ships, new installations default to resumable tasks; an A-only
installation uses cells. Remove `experimental.workflow.world` with an actionable
configuration error pointing to these host bindings, not a silent fallback.

The proposed `defineCellTool` and `defineResumableTaskTool` constructors preserve
the existing public tool metadata/schema/approval fields and add their respective
executor definition. Implement these wrappers in `tools/`, using the existing
tool-stamping and schema normalization helpers. Platform definitions stay in
`compute/`; do not duplicate eve's tool metadata or task lifecycle in the platform.
Session cells and eve background-task records keep their public identities
separate from the platform's internal resource IDs.

## Preserve programmable delegation

Replace the old replay-backed dynamic programming tool with an eve-owned
`Program` tool, enabled by a proposed `experimental_program({ maxSubagents })`
definition. The public name and input contract change; the capability to compose
delegations, fan out, branch on results, loop with explicit state, and aggregate
outputs remains. Do not implement the original suspended-source API as an alias.

Use the existing `phase` sandbox only as an isolated evaluator. Do not import
its durable continuation/resume helpers, and never evaluate model-generated
source in a trusted Node runner. The sandbox has no network, filesystem,
process, environment, package imports, or credentials.

`ProgramInput.source` is a function expression
`(input, state, results) => ProgramStep`. Evaluate one bounded invocation with
initial `state=null`. A `dispatch` return contains new JSON state and 1-32
delegation requests. Persist state, call identities, and child starts atomically
before running them; wait for all requested results before evaluating the next
invocation. `complete` and `fail` terminate the program.

Keys identify logical calls for the entire program execution and cannot be
reused with changed input. Persist the immutable source hash, ABI version 1,
state, previous call keys, and retained results. The same function is evaluated
against explicit state, not replayed to recover earlier JS locals. The deployment
migration must validate ABI/data compatibility; unsupported programs block.

```js
(input, state, results) => {
  if (state === null) {
    return {
      kind: "dispatch",
      state: { phase: "join" },
      calls: [
        { key: "alice", agent: "researcher", input: { message: input.question } },
        { key: "bob", agent: "reviewer", input: { message: input.question } },
      ],
    };
  }
  return { kind: "complete", output: { research: results.alice, review: results.bob } };
};
```

Only agents from the current authorized delegation registry are callable. Enforce
the existing `maxSubagents` default and ownership rules before admitting child
starts, and check authorization again at execution. Bound source to 64 KiB, state
to 1 MiB, sandbox input/output to 16 MiB, each evaluation to 50 ms CPU/1 second
wall time, and the whole program to 1,000 evaluations. Counter limits are durable.
Returns that fail schema validation produce a typed tool error before any calls
are dispatched.

The cell plan implements `Program` with a cell definition; the resumable plan
implements the same state machine through a resumable definition. Test sequential
composition, parallel joins, partial child failure, a bounded loop, cancellation,
restart between dispatch and join, quota rejection, and forged agent names.

## Migration extraction and freeze procedure

Do not write a heuristic that picks the newest step output. v1 uses one explicit
export adapter, `cursor-v1`, for source artifacts containing the current
`SessionStateCursor`/`TurnExecutionCursor` ownership model. Identify support by
verified artifact digest and adapter fixtures, not by a guessed package-version
range. Other artifacts return `UNSUPPORTED_EXPORT`; a namespace with one such
live session cannot cut over.

Build the exporter as a separate offline utility linked to the recorded legacy
artifacts, never as an import in the new runtime. Its procedure is:

Before committing any irreversible source fence, run read-only capture against
a candidate frontier and import it into an isolated target with external effects
stubbed. Verify support, graph completeness, and restoration there first.
Require the source fence operation to validate that expected frontier, or an
equivalent proven pause barrier. If the source advanced, repeat preparation.
Do not terminally cancel production runs to discover whether an exporter works.

1. Stage new channel deliveries and callbacks in `staged_deliveries`, retaining
   original keys and server admission order. Disable source schedules.
2. Finish active external calls or reconcile their uncertain outcomes. Reach
   between-turns or an explicit input/authorization/child wait; arbitrary suspended
   authored JS is unsupported until completed or given a tested export adapter.
3. Establish a source-world write fence for every run in the session/task graph.
   Implement it using the legacy runtime's run-cancellation/storage fence, not an
   eve session reset command. Preserve the complete pre-fence journal. A provider
   adapter must prove that late steps, hook resumes, and queued deliveries cannot
   commit beyond the captured frontier. If it cannot prove that, stop migration.
4. Load recorded inputs, successful step results, hook/timer records, stream
   records, and the original executable artifacts at that frontier. Replay only
   against a read-only adapter: recorded operations return recorded values;
   any unrecorded operation stops replay. Never execute an external step, retry a
   tool, emit a callback, or write to the source world during extraction.
5. Add non-durable capture observers at the ownership points listed below.
   These observers cannot allocate Workflow steps/hooks or alter their IDs.
   Compare replay traces with and without capture instrumentation in fixtures.
6. Emit `MigrationBundle` only when all related runs reach a supported capture
   point and the read-only replay agrees with the frozen frontier. Include hashes
   of payloads, histories, aliases, pending work, and the source proof.

| Capture point in the current source                                                                                                  | Exported authority                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `workflow-entry.ts`, after state adoption, cancellation settlement, alias rekey, and caller settlement, before `nextParkedActivity`. | Session cursor, caller, buffered deliveries/controls, task delivery dedupe sets, timeout, alias, and stream frontier. |
| `turn-workflow.ts`, after coordination dispatch/result adoption and before its durable runtime-action wait.                          | Active turn cursor, pending operation/call IDs, cancellation state, and buffered turn deliveries.                     |
| `tasks/child/workflow.ts`, immediately before waiting for executor traffic.                                                          | Task view, dispatch acknowledgement, pending reports/input, answer routes, and parent address.                        |
| Terminal session/task completion recorded at the frontier.                                                                           | Final result and immutable history; never restart it as active work.                                                  |

Map between-turn captures to an idle session cell. Map explicit turn waits to
`TurnCursor.phase="wait"` with the same request/call IDs. Map retained tool/model
results to completed effect records; map pending known child/input waits to
explicit wait records. Do not map an actively uncertain tool to a runnable effect:
record it indeterminate and require reconciliation first.

Replay remains a migration-only reader of the old format. The new platform's
normal execution and recovery must contain no legacy replay engine. Keep the
offline exporter with archived source artifacts for restore operations.

Import per resource with `(namespace, batch, public ID)` receipts, while the
target namespace is frozen. Batches are resumable; do not attempt a single
transaction covering an entire large namespace. After every resource, validate
counts and hashes against the manifest. Activate the namespace in one final
transaction only after all graph references, permissions, cursors, and pending
work have been verified. Release staged deliveries in their recorded order.

Rollback is automatic only before committing the source write fences. After a
source run is terminally fenced, do not claim it can be unpaused. Keep ingress
staged and repair/complete the import. After new effects execute, recovery is
forward repair or explicit reconciliation, never two live owners.

## Release tasks and review gates

Add these concrete repository deliverables to A1/B1: a migration runner, local
container setup, `compute:dev`, `compute:test:scenario`, and `compute:benchmark`
scripts, and a dedicated scenario Vitest config aliasing source imports.
These script names are work to implement, not commands already present.

The scenario harness starts one isolated PostgreSQL database and at least two
separate supervisors. Expose named failpoints at admission commit, assignment,
transition commit, effect-start commit, external completion, effect-result commit,
wait registration, terminal commit, and deployment activation. Tests release
barriers explicitly; do not depend on arbitrary sleeps.

Use a short lease only in tests through injected scheduler configuration.
Production validation additionally runs the real 30-second lease. Assert database
rows, stream sequences, and a fake external service's call counter independently.
Include lost commit replies, out-of-order IPC replies, restart after a successful
checkpoint reply, stale-owner resurrection, quota contention, and deployment
activation while checkpoint/effect completion is committing.

Require senior review on the storage transaction implementation, source-world
freeze proof, migration capture adapter, sandbox capability boundary, and the
first full failure-injection run. This is verification of specified invariants,
not permission for the implementer to select weaker semantics.
