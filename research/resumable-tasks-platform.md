---
issue: https://github.com/vercel/eve/issues/876
status: proposed
last_updated: "2026-09-09"
---

# Build resumable tasks

## Outcome and relationship to keyed cells

Build resumable tasks: asynchronous execution that saves explicit progress and
recovers from the latest checkpoint using current code. Implement the execution
primitive inside the owned platform rather than wrapping another workflow engine.

This is **plan B**, built on the owned platform from
[plan A](./keyed-cells-platform.md). Reuse its PostgreSQL storage, identity,
worker supervisor, leases, fencing, deployment registry, effect ledger, timers,
authorization, streams, and operations. A resumable task must not introduce a
second database, scheduler, lock service, or parent workflow.

The distinction between the primitives is authoring and recovery:

| Primitive      | Application contract                                                                                                  | What recovers                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Keyed cell     | Receive a message and return an atomic state transition with effect declarations.                                     | Current cell state and unconsumed messages.                                         |
| Resumable task | Execute ordinary async code, explicitly save progress, and provide an entry point that can resume from that progress. | Latest checkpoint, registered waits, and independently committed operation results. |

A resumable task is not an operating-system thread, a persisted JavaScript stack,
or a deterministically replayed workflow. It restarts in current code using an
explicit checkpoint. Refactoring code before that checkpoint must not require
retaining the old function or its historical sequence of `await` expressions.

Distinguish this execution primitive from eve's existing background task record.
Use `resumableTaskId` for execution identity and retain `taskId` for the
user-visible background task. One background task can own a resumable execution.

These are proposed APIs and implementation requirements. Nothing in this
document describes an already-shipped eve feature.

This plan includes the shared [implementation appendix](./compute-spec/README.md),
[contracts](./compute-spec/contracts.ts), and [database DDL](../packages/eve/src/compute/storage/migrations/0001_baseline.sql).
Use those files as the reference for exact interfaces and storage, and the
execution rules below for concurrent calls, lifecycle transitions, and recovery.

## 1. Establish prerequisites and ownership

Complete A1-A5 from the keyed cells plan before relying on resumable tasks for
durable work. A6-A8 can then use this plan's eve integration instead of the
cell-only tool authoring path. Cell-only execution remains usable; the first
resumable task release does not need a second production rollout of every eve feature.

Add `packages/eve/src/compute/resumable-tasks/` with definitions, execution, checkpoint
storage, signals, wait resolution, and lifecycle transitions. Export eve-owned
types from the same proposed `eve/compute` entry point. Keep HTTP endpoints,
database credentials, artifact loading, metrics, and worker process management
in the shared platform modules.

Represent a resumable task as a platform resource with the same address and lease
rules as a cell. Use a reserved definition family for its platform driver, with
the authored definition ID stored in metadata. The driver is platform code,
not a session-length application workflow. It never replays an event history to
reconstruct a program.

Each resumable task has one execution owner at a time. The owner may await ordinary I/O,
but all checkpoint writes and terminal results require a live ownership epoch.
Control operations can cancel the resumable task without waiting for its JavaScript
callback to return.

## 2. Implement the authoring contract

Define the following proposed interface. Support serializable inputs, explicit
checkpoint versions, and independently versioned effect inputs. Resolve
definition IDs from authored file paths through the deployment manifest.

Implement `ResumableTaskDefinition` and `ResumableTaskContext` exactly as defined
in [contracts.ts](./compute-spec/contracts.ts), including schemas, `effectBatch`,
child creation, wait results, and explicit wait acknowledgements. The same file
defines every wait/result/error type referenced by those interfaces.

Implement `defineResumableTask(definition)` and client operations `start`, `inspect`,
`signal`, `cancel`, and `readEvents`. Creation requires an idempotency key.
Return the same resumable task ID for repeated identical starts and reject conflicting
input. `start` is a durable receipt operation, not a promise tied to task
completion.

`ResumableTaskWait` is a discriminated union of a named signal, an absolute timer, a child
resumable task result, or an all-of set of those waits. Bound a set to 100 entries.
Implement only these wait forms in v1. There is no unbounded condition query,
arbitrary serialized promise, or function predicate stored in the database.
Each park has an explicit stable wait key. `waitResult` returns the resolved
value or typed failure for that key without consuming it. An all-of result maps
condition IDs to their results. Checkpointing with `acknowledgeWaits` atomically
records progress past those results; until then they remain available on retry.
The `child` method atomically saves its checkpoint and registers an idempotent
child start. Children are owned unless `detached: true` was explicitly supplied.

`checkpoint` resolves only after persistence. `effect` atomically saves its
supplied checkpoint and registers a stable operation before dispatch.
`park` atomically saves the checkpoint and wait, then releases the execution
process's reference to this invocation. It has no resumed JavaScript continuation:
the next activation calls `resume`.

Use a runtime-owned suspension signal to unwind `park`; catch it only in the
platform executor. After a successful park, the execution token becomes invalid,
so user code that catches the signal cannot continue durable work. Document
that `finally` blocks are not a durable cleanup mechanism; persistent cleanup
must be represented as an explicit effect or cancellation transition.

### Example: checkpoint around an external operation

This example specifies the proposed API, not an import that exists today.
The effect definition's retry policy is registered separately in the deployment
manifest.

The complete [report example](./compute-spec/example.ts) supplies input,
checkpoint, and output validators as well as `start` and `resume`. It is
typechecked against the proposed contracts and has a
[recovery test](./compute-spec/example.test.mjs). During B1, register that
definition through the actual new public export and turn the test into a real
platform scenario. Its validators accept version 1; later schemas require
explicit forward transforms.

If the worker dies after the effect succeeds but before saving `finished`,
`resume` asks for the same operation ID and receives its committed result.
It does not reexecute the completed operation. A changed operation input with
the same key is an error, not a cache miss.

## 3. Add storage without a second source of truth

Reuse the shared resource identity and ownership row. Add execution metadata in
a `resumable_tasks` table keyed by that resource ID:

- Definition ID and input bytes/version.
- Checkpoint bytes/version/revision, initially absent.
- Status: `ready`, `running`, `waiting`, `completed`, `failed`, `cancelled`, or
  `blocked`.
- Retry count and terminal result/error reference. The shared cell row owns
  next eligible execution time and cancellation generation.

Use a separate `resumable_task_signals` table for buffered input with unique
`(namespace_id, resumable_task_id, signal_id)` and an input hash. Add
`resumable_task_waits` for the active wait generation, explicit conditions,
matched result references, and resolution status. Operation data remains in
the shared `effects` table.
Do not copy results or timer state into a second resumable task journal.

Implement these storage operations behind one internal transactional API:

| Operation       | Atomic changes                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Start           | Create resource, input, initial ready state, and start receipt.                                                                |
| Save checkpoint | Verify execution epoch/status, replace checkpoint/revision, and acknowledge explicitly listed wait results.                    |
| Register effect | Save checkpoint; insert or verify effect identity/input; register the resumable task's dependency on its result.               |
| Park            | Save checkpoint; install wait generation; consume already matching buffered signals if available; release the execution token. |
| Resolve wait    | Match each condition once; when complete, mark the resumable task ready and retain matched result references for `resume`.     |
| Complete        | Record result, mark terminal, emit terminal event and parent notification, and release ownership.                              |
| Cancel          | Increment cancellation generation, mark terminal cancelled, invalidate execution, and request cancellation of owned work.      |

A warm `effect` call can await its result in memory. The durable dependency
exists first. Completion wakes the current owner when valid; if the owner has
died, it makes the resumable task runnable for `resume`. Establish the wake subscription
before rereading the durable dependency/result, then recheck on notifications and
bounded fallback polls. An unlocked read followed by subscription can miss a
completion between them. Worker-local promises are an optimization, never the
work record.

Keep at most the latest checkpoint as execution state. Retain previous checkpoint
metadata and hashes for diagnostics, not an unbounded execution journal. Reuse
the platform codec, payload limits, large-result references, dedupe retention,
and data-access authorization.

## 4. Implement execution and failure behavior

On activation, acquire the shared lease, resolve the current approved deployment,
and migrate input/checkpoint before entering application code. If no checkpoint
exists, call `start`; otherwise call `resume`. Never infer a resume location from
a function name, instruction pointer, or recorded step count.

During normal execution, permit ordinary async code between checkpoints.
Code in that interval can run again after a failure. Route durable external
effects through `ctx.effect`; raw external side effects in `start` or `resume`
do not receive platform deduplication. Direct reads may repeat, including model
requests with a billing cost; document that explicitly.

Use the same 30-second lease and 5-second renewals as cells. All runner writes
carry an execution epoch and cancellation generation. On owner loss, mark the
resumable task ready for recovery unless it is waiting on a known pending operation or
durable wait. A still-running effect retains its own independent lease; do not
start a duplicate effect merely because its parent resumable task lost ownership.

Classify outcomes as follows:

| Outcome                                      | Required behavior                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Process loss or expired resumable task lease | Recover from checkpoint after ownership takeover.                                         |
| Registered wait                              | Release compute and leave `waiting`; a timer/signal/result makes it ready.                |
| Explicit transient application error         | Retry from checkpoint up to five times with the shared backoff policy.                    |
| Unclassified application exception           | Mark failed and expose a sanitized error; no automatic infinite retry.                    |
| Checkpoint/input migration failure           | Mark blocked with data unchanged.                                                         |
| Indeterminate non-repeatable effect          | Mark blocked and require effect reconciliation; do not restart the entire resumable task. |
| Cancellation                                 | Commit cancelled, abort cooperatively, reject later writes/results as stale.              |

Before a terminal commit, check for cancellation in the same transaction.
Whichever terminal transition commits first wins; cancellation of an already
completed resumable task is a no-op. Propagate cancellation to owned children by durable
messages. Children declared detached at creation remain running; no implicit
ownership inference from their addresses.

Limit an execution slice to 60 seconds without a checkpoint, including awaited
I/O. The supervisor requests a cooperative stop, then invalidates the runner and
terminates its process if it does not stop within 5 seconds. The independently
registered effect can continue on its own owner within the shared effect timeout.
A checkpoint resets the slice deadline. CPU-bound code must yield to the event
loop; process supervision is the fallback when an `AbortSignal` cannot run.

## 5. Make waits, children, and signals race-safe

Implement signal admission before wait APIs. Persist every authorized signal with
its stable delivery ID and expected logical request/cancellation generation.
Different content under a repeated ID is a conflict. Unknown or terminal resumable tasks
reject new signals rather than creating an implicit task.

For `park`, lock the resumable task while installing the wait and inspecting buffered
signals. For `signal`, lock that same resumable task before buffering/matching. This makes
signal-before-wait and wait-before-signal equivalent. Match at most once, record
which signal satisfied which condition, and keep the value available until the
resuming code checkpoints past it. Bound unmatched buffered signals to 1,000 per
resumable task; reject excess signals before claiming durable acceptance.

Create timers and register timer waits in the same transaction. Timer delivery
uses the wait generation, so a replaced wait cannot consume an old alarm.
An all-of wait resolves only after every recorded condition has settled.
For v1, a failed/cancelled child resolves its condition with a typed failure
result; it does not automatically fail the parent.

Create child resumable tasks through a staged start operation with a stable child ID,
checkpoint, and parent relationship in one transaction. Parent completion waits
use that identity. Child terminal state and its outgoing notification commit
together; the parent deduplicates notification delivery. Never poll child state
inside an allocated executor.

Authorization and human approval still belong to eve, not the generic resumable task
platform. The platform verifies the caller's resource access; eve additionally
verifies the principal, request ID, and requested operation before admitting an
answer. A public signal address is not an authorization capability.

## 6. Make deployments independent of suspended programs

Reuse plan A's deployment epoch and migration barrier. When a new deployment
becomes active, old resumable task owners may finish their current bounded slice or save
a checkpoint, but cannot start new old-version effects. Treat an attempted
checkpoint at that barrier as a checkpoint-and-release: save compatible durable
progress under the old schema, invalidate the old owner, and enqueue migration
to the desired deployment before running again.

Implement checkpoint-and-release as a distinct storage operation under plan A's
namespace/resource lock order. It is permitted only while the resource still has
that old adopted deployment and the submitting lease remains valid. It may save
old-schema progress and release ownership, but cannot register effects, emit new
application output, or modify a resource already adopted by newer code.

Do not let an old runner continue after that release. The supervisor aborts it
and the database rejects any later attempt to checkpoint, emit, or complete.
Migrations execute with the resource fenced and are atomic with version adoption.
If the old execution never checkpoints, terminate it at the slice limit and
resume from the last committed checkpoint under the new version.

Checkpoint phases are data contracts. Renaming or removing a phase requires a
forward migration to a phase the new `resume` understands. Buffered signals,
wait results, and unresolved effect descriptors are also data that may need
explicit migration. Do not claim zero schema compatibility.

Already started external operations retain their original request identity and
known outcome. New code consumes that outcome using a declared data migration.
An incompatible change that cannot interpret a pending effect blocks the resumable task
instead of rerunning the effect with new arguments.

A migration transform can be removed once an inventory proves no live or pending
resource needs it and the retained restore procedure has an offline conversion
path. Historical backups do not silently become readable by arbitrary newer code.

## 7. Integrate resumable tasks with eve

Use keyed cells for session identity, channel aliases, authorization records,
stream directory, and short control transitions. Use one resumable task for a logical turn
and one resumable task for an independently continuing authored background task.
The session cell is not a pinned workflow: it only admits deliveries, chooses
which turn is active, processes results, and records lifecycle changes.

Start the turn's resumable task and record its identity as one staged operation
in the session cell's commit. On completion, atomically record its result and an
outgoing session message. The session accepts results only for its current turn
generation. This does add a logical session/turn boundary; it must use the
shared transaction/worker path, not a chain of workflow starts and hook claims.

Implement `createResumableTaskRuntime` against the existing `Runtime` interface.
Reuse plan A's extracted model/tool preparation and state-adoption functions.
Checkpoint at these boundaries:

1. Input accepted and current history revision selected.
2. Model operation registered, with stable turn and model-call IDs.
3. Completed model result retained, including persisted tool-call IDs.
4. Each tool invocation registered and each tool result independently retained.
5. Pending approval, authorization, child result, or human input registered.
6. Final output, usage, session updates, and completion notification committed.

Checkpoint data contains session/turn IDs, turn generation, phase, history
revision, context version, operation IDs, and references to retained results.
Do not persist hydrated tool functions, model instances, `AbortController`,
streams, module objects, or arbitrary closures. Rehydrate those from the current
deployment and registered context codecs.

Add `defineResumableTaskTool` in the eve-owned public surface. Preserve existing tool
input/output schemas, approval policy, progress reporting, and background task
receipts, but require `start`/`resume` and explicit checkpoints for durable waits.
Implement `ask` and `agent` as eve helpers that create the corresponding pending
record and call `park`; they do not preserve an arbitrary awaiting JS stack.
Examples must show a resume phase that consumes the answer or child result.

Replace `defineWorkflowTool`, `"use workflow"`/`"use step"` compilation for these
tools, and workflow hook helpers after their fixtures have explicit replacements.
Implement the appendix's `Program` tool using explicit program state, child-call
batches, and `park`; preserve programmable delegation without retaining the old
replay-backed engine. Ordinary non-durable tools keep their authoring model.

Do not checkpoint once per streamed token. Reuse plan A's bounded durable stream
batching. Model/tool output that has already been persisted remains inspectable
after retry; the session only adopts results belonging to its accepted turn.

## 8. Migrate existing workflows and cell-only execution

Use the same controlled migration and verification procedure as plan A.
For each exportable legacy turn/task, convert the durable data into an explicit
resumable task phase and retained operation/wait references. Preserve task IDs, approval
request IDs, session aliases, and stream cursors.

Use `cursor-v1` extraction and the exact source capture points in the appendix
for between-turns, human input, authorization, child/task waits, and completed
results awaiting adoption. Test each captured state against its source artifact.
Unknown artifacts or states block migration. Never map a suspended instruction
pointer to a guessed phase; finish such work or implement and verify another
explicit capture adapter first.

If plan A has already shipped cell-only execution, migrate one quiescent session
generation at a time: retain the same session cell, create a resumable task checkpoint
from its active-turn state, atomically mark the resumable task as the new execution owner,
and reject later cell-only executor completions for the old generation.
Do not run both execution drivers against one turn.

The rollback and bounded callback relay rules are unchanged from plan A.
After the new resumable task executes an external operation, a rollback needs
reconciliation; changing a routing flag is insufficient.

## 9. Build in independently testable increments

| Increment | Deliverable                                                                                    | Acceptance gate                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1        | Definitions, input/checkpoint validation, storage schema, start/inspect/cancel API.            | Conflicting starts fail; a start receipt survives API/worker restart; no application closure is serialized.                                                     |
| B2        | Runner, checkpoint writes, ownership fencing, recovery and slice deadlines.                    | Kill before the first checkpoint, after checkpoint, and before completion; recovery enters the defined start/resume path and rejects stale writes.              |
| B3        | Atomic checkpoint/effect registration, retained result lookup, retry classification.           | Kill after an external result commits but before the next checkpoint; recovery obtains that result without executing the completed effect again.                |
| B4        | Signals, parking, timers, children, all-of waits, cancellation.                                | Signal/wait and cancel/complete races have one durable outcome; waits survive a completely stopped worker fleet.                                                |
| B5        | Deployment barriers and migrations.                                                            | Change branches and code ordering before a checkpoint, deploy, and resume from current code without historical replay; incompatible pending data blocks safely. |
| B6        | `createResumableTaskRuntime`, per-model/tool checkpoints, `defineResumableTaskTool`, fixtures. | All selected eve session, task, input/auth, cancellation, sandbox, and streaming tests pass against resumable tasks.                                            |
| B7        | Legacy converters, canary migration, soak/performance tests and cleanup.                       | Controlled migration passes; no Workflow engine remains reachable; shared performance and durability gates pass.                                                |

### Required failure matrix

Automate these as scenario tests with the real database and separate worker
processes. Use named failpoints, not timing-only sleeps:

| Failure point                                                        | Assertion                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Start commits; API response is lost.                                 | Client retry returns the same resumable task.                                      |
| Effect/checkpoint registration commits; worker dies before dispatch. | The recorded effect eventually runs; its identity is unchanged.                    |
| External action runs; result commit is absent.                       | Idempotent policy retries safely; manual policy blocks as indeterminate.           |
| Effect result commits; parent does not observe it.                   | Resume reads retained result without another completed invocation.                 |
| Signal arrives before, during, or after park.                        | Exactly one matching condition consumes it; no accepted signal is lost.            |
| Child completes before parent registers its wait.                    | Parent resolves from retained child result/notification.                           |
| Cancellation races checkpoint or completion.                         | One terminal result wins; no later checkpoint resurrects the resumable task.       |
| Old runner returns after lease takeover or deployment adoption.      | Its checkpoint, stream append, and completion are rejected.                        |
| New code removes a saved checkpoint phase.                           | Explicit migration succeeds or resumable task becomes blocked; no replay fallback. |
| Database failover or notification loss.                              | Durable inventory recovers work; no acknowledged state disappears.                 |

Use unit tests for checkpoint migrations and lifecycle decisions, in-memory
integration tests for driver contracts, platform scenario tests for database and
process behavior, and CI-only fixture evals for the complete eve experience.
Also test namespace authorization, message size limits, unknown checkpoints,
effect-key input conflicts, credential-free checkpoints, quota exhaustion,
and cleanup of terminal dedupe records.

### Performance and release gates

Use the same workload, measurement boundaries, and failure/soak gates as plan A,
including the warm in-region p95 below 100 ms from admission to model/effect
invocation at 100 messages/second across 100 sessions. Report resumable task scheduling
and checkpoint cost separately from cell admission and database writes.

Measure one tool call, ten tool calls, parked/resumed turns, and histories with
1, 10, 100, and 1,000 prior turns. Recovery should read the latest checkpoint and
referenced data, not execute earlier application code. Checkpoint payload growth
must track active work, not the entire historical execution log.

Ship only after B1-B7 and the shared platform gates pass. Update the public
execution/tool/deployment documentation, publish complete resume examples, and
include a minor changeset for removed public Workflow APIs. Remove old transforms,
world packages, pinned-driver protocols, and compatibility paths after the verified
cutover. These are release requirements, not work already performed by this plan.

## 10. Exact execution algorithms

The shared contracts and DDL include the task, signal, wait, result, batch,
dependency, and command-receipt records. Implement the following algorithms,
rather than leaving their ordering to each adapter.

### Concurrent calls and command acknowledgement

Allow one unresolved durable method per `ResumableTaskContext`: `checkpoint`,
`effect`, `effectBatch`, `child`, `park`, or `emit`. A second overlapping call
fails locally with `ComputeError("CONCURRENT_MUTATION", ...)` before admission.
It does not undo the first call. The restriction lasts until the first method's
promise settles, not just until its registration RPC returns.

For parallel work, use `effectBatch({ key, checkpoint, effects })` with 1-32
distinct effect keys. Store the ordered batch fingerprint in `effect_batches`
and register all effects/dependencies in one checkpoint transaction. Return
`BatchOutcome[]` in requested order, retaining each individual failure/result.
Reusing the batch key with changed membership, ordering, or input is a conflict.
An indeterminate manual effect blocks the task pending reconciliation.

Create parallel children through sequential awaited `child` registrations, then
park on an all-of child wait. Registration is fast and does not await child
completion. Child keys deduplicate starts across recovery. Do not use
`Promise.all` over independent checkpoint-writing methods.

`waitResult` is read-only and may overlap a durable method. It does not change
checkpoint revision or acknowledge results. Application code validates signal
business data after decoding; the platform validates only the registered
envelope/codec and wait correlation.

The SDK retains the exact request ID, command sequence, and encoded request until
it receives a durable reply. A transport retry reuses all three. Update the local
checkpoint revision only from that reply; an ambiguous response is not permission
to issue another mutation under a new ID. The server's transaction stores the
mutation and `execution_commands` response together.

Internal `expectedRevision` refers to `checkpoint_revision` for task mutations.
Public administrative commands use `TaskView.revision`. Every checkpoint changes
both; buffered signal arrival changes the administrative revision but not the
checkpoint revision. Ownership/cancellation checks are mandatory regardless of
which revision is being compared.

### Start and task ownership

`startTask` locks the namespace and reserves the namespace-scoped start key.
Create a `cells` row of kind `resumable_task`, with null cell state, plus its
`resumable_tasks` row and versioned input in one transaction. The task's checkpoint
exists only in `resumable_tasks`; do not duplicate it in `cells.state_ref`.
Return the existing resource for identical starts and conflict otherwise.

`claimTask` uses the shared cell lease and sets task status running. A ready
resource with no checkpoint enters `start`; one with a checkpoint enters
`resume`. Increment assignment/lease epoch, not cancellation generation, on
ordinary recovery.

The cell's `generation` is the sole cancellation counter for resumable resources;
`TaskView.cancellationGeneration` reads it. Signals and task effects carry this
generation. A normal checkpoint or deployment adoption cannot invalidate a
legitimate pending operation by changing it.

Native control operations may lock/update task metadata while an application
runner owns the execution lease. This applies to signal admission, dependency
completion, cancellation, and timer matching, not arbitrary application state.
Native controls never write checkpoints. They wake a valid runner or make a
waiting/unowned task ready; they cannot schedule a second application owner.

### Checkpoint and effects

`saveCheckpoint` verifies namespace/deployment permission, owner/assignment,
unexpired lease, generation, running status, and expected checkpoint revision.
Validate with the adopted definition's checkpoint schema. Insert the new payload,
advance checkpoint/admin revisions, acknowledge explicitly listed resolved waits,
and record the IPC response together. An unknown or pending acknowledged wait
fails the whole transaction; an already acknowledged wait is a no-op.

`registerEffects` performs that same checkpoint operation and verifies/inserts
effect and batch identities before committing. Do not dispatch a single member
before the entire batch registration commits. Completed operations return their
retained output after the current effect definition's `migrateOutput` and output
schema validation; the original ledger result is never rewritten. Existing running
operations retain their independent owners.
A single `effect` uses an internal batch key derived from its effect key.

Keep the application task running while a warm caller awaits a result. Completion
of an effect records an outgoing protected completion and wakes the owning
application process if its lease is valid. The process subscribes, rereads the
durable effect state, and rechecks on notifications or bounded fallback polls.
It must not depend on a notification arriving after subscription.

The native completion handler deduplicates the completion, checks its effect ID
and generation, and updates dependencies. If the application lease is still
valid, it leaves the task running. With no valid owner, it changes a task with
all dependencies settled to ready; unresolved dependencies leave it waiting.
An indeterminate dependency produces blocked, not ready. Reconciliation uses the
same completion path to unblock the task.

When an execution slice expires during an effect wait, invalidate the application
lease and set waiting with its existing dependencies. Do not cancel the effect
or create another one. If dependencies already settled, make the task ready
instead. The shared repair scanner derives this state under the same resource
lock, so a simultaneous effect completion cannot lose a wakeup.

### Park, match, resume, and acknowledge

Normalize a single `WaitCondition` to a one-element condition array. For an
all-of wait, require 1-100 distinct condition IDs and disallow nested all-of sets.
Each child condition must refer to a child created by the caller, including
detached children; an arbitrary resource ID is not a valid child wait.

`parkTask` uses the checkpoint transaction above, validates the stable wait key,
and increments `wait_generation` for a new wait. Store a fingerprint of the
condition array. A repeated wait key with different conditions conflicts.
An acknowledged wait key cannot be reopened; use a new key for a new logical wait.

While holding the resource lock, match buffered signals by signal key and the
current cancellation generation, choosing the lowest accepted order. Read
already-terminal child results and create timers for timer conditions. Insert
at most one `wait_results` row per condition. One signal can satisfy only one
condition. Set ready if every condition already resolved, otherwise waiting.
Then invalidate/release the old execution lease and record the command response.
This transaction must complete before the runtime unwinds `park`.

`signalTask` authorizes the resource, checks the generation, and deduplicates
signal ID/content before applying the terminal-resource rule. An identical retry
of a previously accepted signal returns its old receipt even after task
completion. A new signal to a terminal task is rejected. Insert a buffered signal
or match one pending condition under the resource lock; only transition
waiting-to-ready when all conditions have results.

For a single signal or child condition, `waitResult` returns its `Result<T>`.
For a timer it returns success with `{ deadline, firedAt }`. For an all-of wait,
return success whose value maps condition IDs to their individual `Result`
values, including failed/cancelled children. It is the application's decision
how to handle those results; the primitive does not fail the parent implicitly.

Keep results until the caller checkpoints with `acknowledgeWaits`. Re-reading
after a crash returns the same result. After acknowledgement, keep the dedupe/
wait tombstone until task retention expires, but the result payload may be
collected if it has no other references.

### Fail, retry, cancel, and complete

Expose the eve-owned `ComputeError` from the contracts. Only
`ComputeError("TRANSIENT_FAILURE", ...)` requests an application retry.
An ordinary thrown error is permanent by default. Serialize only the defined
failure fields across IPC; stack traces stay in private diagnostics.

A task has at most five attempts without changed checkpoint content, using
1/2/4/8-second full-jitter delays. Compare payload hashes: merely rewriting the
same checkpoint under a new transport revision does not reset the counter.
Lease loss during an unresolved registered effect does not spend
application retries or start another effect. Repeated no-progress process losses
at the same checkpoint do count once the task is reactivated; quarantine after
the fifth instead of scheduling an infinite crash loop.

`completeTask` requires no unresolved owned effects, no pending wait, a valid
execution token, and an output passing the definition schema. Owned children
must be settled before returning; only children created with `detached: true`
may continue. Commit the terminal result, terminal cell
state, parent notification, event append, and command response together.
On failure, retain the checkpoint/results, cancel owned unfinished work, and
commit a typed terminal failure plus the same notification path.

`cancelTask` locks the cell and task, deduplicates the administrative request,
and returns a no-op view when already terminal. Otherwise verify public revision,
increment the shared cancellation counter and execution epoch, mark cancelled,
invalidate ownership, cancel native waits/timers, mark owned effects for
cancellation, and stage child-cancel/parent-notification messages together.
After commit, request cooperative process abort. Cancellation is not rollback
of a tool's external effect.

Late protected child/effect/timer completion to a terminal parent is recorded
as obsolete and acknowledged by the native control handler. It does not reopen
the task or create a retry storm. Ordinary new application messages/signals to
terminal resources remain errors.

### Required additions to the failure tests

Add assertions for overlapping mutators, a successful commit with a lost IPC
reply, changed effect-batch membership under the same key, wait acknowledgement
rollback, two matching signals racing one condition, signal retry after terminal
completion, dependency completion during slice expiry, and cancellation of an
owned child while another detached child continues. Compare both the public
result and the relevant database rows.
