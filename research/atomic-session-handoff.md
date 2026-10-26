---
issue: TBD
status: in-progress
last_updated: "2026-10-20"
---

# Atomic session handoff

## Summary

A session handoff moves an idle session to a successor workflow run, either on the deployment
that accepted a new delivery or on the same deployment after compaction. Customers see the first
message after a handoff take 9 seconds or more. The cause is structural: the current protocol
releases every session hook before it starts the successor, so it pays for a release/claim
handshake and covers the resulting no-owner interval with markers, an ingress retry loop, and an
activation round trip. That puts about 10 serial durable operations in front of the user's
message, where an ordinary turn has one.

Workflow now ships the atomic primitive the original handoff design was waiting for:
`createHook({ token, experimental_force: true })`. Both first-party Worlds declare
`hookForceClaim: true` (`@workflow/world-vercel` 5.2.0 and `@workflow/world-local` 5.1.0), and
current runs are stamped at the spec version that understands a takeover (8). This plan replaces
the release-based handoff with a force-claim protocol (handoff version 3):

- The current owner never releases its hooks. It starts the successor and keeps serving its inbox.
- The successor validates, force-claims the whole hook set in one batch, and runs the triggering
  delivery right away.
- The old owner sees the takeover and forwards whatever it accepted but never read. The successor
  processes those messages before anything it received directly.

The critical path goes from about 10 durable operations to 4. No address is ever without a live
owner, so ingress never retries, a channel never gets `session_not_ready` because of a handoff,
and a compaction handoff can no longer be abandoned by a racing reply.

There is no public API change. Observable changes:

- Lower latency for the first message after a deployment or compaction handoff.
- Compaction handoffs never ride on a message.
- Rolling back to an eve build older than this protocol leaves existing sessions on the newer
  owner, as a checkpoint version bump already does.

This plan replaces the release-based handoff and compaction trigger from the single-workflow
session design ([#876](https://github.com/vercel/eve/issues/876)). The rest of that design is
unchanged: one owner runs turns, the original run anchors the stream, checkpoints carry settled
state, and handoff targets the exact accepting deployment.

## Where the time goes today

Measured with `world-local` (integration tier, same machine). Times are from `hook_received` on
the old owner A:

| ms      | Run | Durable operation                                               |
| ------- | --- | --------------------------------------------------------------- |
| 46–88   | A   | `isSessionIdleForHandoffStep` (pure check, run as a step)       |
| 91      | A   | anchor hook created, `getConflict` awaited                      |
| 98      | A   | handoff marker hooks created, awaited after the anchor          |
| 103–147 | A   | `releaseSessionHooksStep`; the no-owner interval starts         |
| 150     | A   | activation hook created, awaited                                |
| 155–207 | A   | `startSessionOwnerStep` (cross-deployment probe, `run_created`) |
| 247–287 | B   | `validateSessionCheckpointStep` (bundle load on a cold process) |
| 290–331 | B   | `recordSessionOwnerStep`                                        |
| 335     | B   | session hooks claimed; the no-owner interval ends               |
| 339–384 | B   | `signalSessionOwnerActivationStep`, awaited before the turn     |
| 394     | B   | `turnStep` starts                                               |

An ordinary turn reaches `turnStep` 57 ms after `hook_received`, with the abort hooks as its only
durable operation. On Vercel each row costs at least one network write plus a replay, and a step
that cannot run inline costs a queue hop. The successor's first process on a new deployment also
starts cold.

Two costs fall outside the table:

- **Cross-deployment capability probe.** `start()` probes the target deployment before every
  cross-deployment start (`CROSS_DEPLOYMENT_CAPABILITY_PROBE_TIMEOUT_MS = 10_000`). The result is
  cached per process for 10 minutes, so the first handoff from each old-deployment process pays a
  round trip that invokes the new deployment. eve cannot skip the probe; see
  [Upstream follow-ups](#upstream-follow-ups).
- **Compaction double handoff.** The eager compaction transfer starts after `session.waiting`. A
  reply accepted before the release commits makes the owner abandon the attempt, reclaim its
  hooks, and then carry a second full handoff on that reply (`runDeliveredTurn` passes
  `dueCompactionHandoff()`). That first message pays for roughly two handoffs. A reply that lands
  in the no-owner interval instead polls in ingress for up to 5 seconds
  (`HANDOFF_RETRY_WINDOW_MS`) and then gets a 409 `session_not_ready`.

## The primitive

From `@workflow/core` 5.2 and `@workflow/world` spec version 8, a forced hook creation:

- always ends with the claimer owning the token. Concurrent claimers converge on one owner.
- disposes the previous owner's hook and wakes that run. The previous owner's payload awaiters
  reject with `HookForceClaimedError`, which carries `claimedByRunId`.
- keeps every payload delivered before the takeover with the previous owner. Its iterator drains
  those payloads first and only then rejects. The takeover is ordered after them.
- redirects every later `resumeHook(token)` to the new owner, including resumes already in flight
  that hit the old owner. Each redirect is the same logical resume with the same dedup id.
- is refused with an ordinary `HookConflictError` (`forceRefusedReason: 'victim-spec-version'`)
  when the holder is a running victim stamped below spec version 8.

`start()` cannot take a caller-chosen run id or an idempotency key, so a start step retried after
`run_created` can create two candidates. With forced claims, both would win in turn. The protocol
fences this itself.

## Protocol (handoff version 3)

```text
A: current owner                          B: successor (target deployment)
────────────────                          ────────────────────────────────
eligible delivery dequeued
startSuccessorStep ──────────────────────▶ boot
  (idle check + start, one step)           claim attempt lease (ordinary claim)
keeps owning and pumping its inbox;        prepareSuccessorStep: migrate, validate,
runs no turn while the attempt is open       record $eve.version, warm the bundle
                                           force-claim the full hook set (one batch)
pumps drain, then HookForceClaimedError ◀─ ownership moves
                                           first turnStep(delivery)   ← model work
handover(leftovers) ─────────────────────▶ inbox gate opens; leftovers go first
exits, or parks as the stream anchor
```

### Owner (A)

1. **No separate hook barrier.** The attempt's outcome hook (`<runId>:handoff:<attempt>`) and, on
   the original run's first attempt, the stream anchor are created in the same suspension as the
   start step, without awaiting `getConflict`. Their tokens are unique, the suspension commits
   them before the step runs, and the step can still run inline.
2. **One step to start.** `startSuccessorStep` runs the idle check with the source's code and, if
   the session is idle, starts the candidate. The step returns `not-idle`, `started` with the
   candidate's run id, or `unsupported` when the World does not declare both `hookForceClaim` and
   active `hookRetention` (see [Compatibility](#compatibility)). The candidate input carries the
   checkpoint, the triggering delivery, `handoffVersion: 3`, A's exact logical hook set
   (`hookTokens`), A's run id (`sourceRunId`), and an attempt key (`<A runId>:<attempt index>`)
   that is deterministic under replay. `start()` can create the run and still fail, so a failed
   start step is not proof that no candidate exists, and a retried start step can leave a
   duplicate; A therefore fences the attempt (below) before any retained outcome.
3. **Keep serving.** A keeps every hook and keeps queueing arrivals. It runs no turn until the
   attempt settles.
4. **Settle on exactly one outcome:**

| What A observes                                             | Outcome     | A's action                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every session hook force-claimed by the same run            | transferred | Drain the queue and send it as `handover` parts, then exit (or park as the anchor).                                                                                                                          |
| `incompatible` verdict, no hook taken                       | retained    | Remember the deployment as incompatible, then run the delivery here.                                                                                                                                         |
| `failed` verdict, no hook taken                             | retained    | Run the delivery here; retry at the next eligible delivery.                                                                                                                                                  |
| `failed` verdict with `claimedHooks: true`                  | retained    | Force-reclaim the full hook set with the gate armed and run the delivery at once; the candidate's `handover` lands behind it, which keeps FIFO because the trigger precedes anything the candidate accepted. |
| `failed` with `HookConflictError` (successor older than v3) | retained    | Treat as `known-incompatible` for that deployment.                                                                                                                                                           |
| The candidate run ended with neither takeover nor verdict   | retained    | Force-reclaim the full hook set (forced claims replace A's own hooks, so pump timing does not matter), then run the delivery.                                                                                |
| Input waits through the boot deadline (5 min), no verdict   | retained    | Fence; if no live candidate holds the lease, run the delivery (reclaiming the full set if a lease holder ended).                                                                                             |

The takeover itself is the success signal. Because A waits for every one of its pumps to close,
the leftovers it forwards are complete. The handover goes through the stable address, which
reaches whoever owns it, so A does not check which run took its hooks. A forced reclaim of a
token A still holds replaces A's own hook with a fresh one (Workflow lets a run take a token from
its own earlier hook), so the reclaim is correct even if a takeover has not reached A's pump yet.
While a handover is awaited A attempts no new transfer. The `failed` verdict carries
`claimedHooks` so A knows whether to reclaim, and v3 verdicts carry the successor's `runId`;
`SessionOwnerActivation` otherwise keeps its shape.

**Fence before retaining.** Every retained outcome after a candidate may exist (failed start
step, any verdict, the candidate ending, the boot deadline) first passes `fenceAttempt`: A
ordinary-claims the attempt's lease and holds it for the rest of its run, like a successor:
`dispose()` would free the token at once for a late candidate, and retention covers the time after
the run ends. Winning it shuts every candidate out. A conflict naming the
run that gave the outcome, or a run that has ended, means that candidate gave up. A conflict
naming a different live run (the lease winner, when the outcome came from a duplicate) sends A
back to waiting, now watching that run. The healthy path never fences. Only a lease holder can
have claimed addresses: one that gave a verdict reports what it holds, and A force-reclaims the
full set from any other that gave up.

**Handover parts.** A sends leftovers one payload per part, each carrying the attempt key and
an index, then a final part with the next index. Each payload was accepted on its own, so no
part exceeds a limit the original did not. The gate applies parts in index order at the armed
position, ignores repeated indexes (a retried send step repeats its index), and opens once the
final part and every part before it have been applied. Every part, data and final alike, is
retried with durable backoff until delivered or the session has ended (`HookNotFound`), so no
accepted message is dropped and a takeover always ends with a final part.

**Counterpart watch.** No wait on the other run is unbounded once that run is gone. A shared
helper sleeps durably (10 s) between checks of the run's status, keeps looping when a check
fails, and stops as soon as the awaited event happens. An open wait due within the invocation's
inline window (2, 5, or 10 minutes by function deadline, plus 30 s skew) turns off Workflow's
inline step delta, so no watch runs on the healthy path:

- A awaiting the takeover or verdict records the attempt's start, before the start step, on the
  replay-stable workflow clock. A stuck attempt only matters once input is waiting, and all input,
  including the session timeout command, arrives through the inbox, so A sets no timer while the
  inbox is empty; it races the next arrival instead. Once input is pending, A races one durable
  sleep for the time left until 5 minutes after the start. Reaching it fences the attempt; if a
  live candidate still holds the lease, A watches that run.
- A gated after a `claimedHooks` failure, and B gated awaiting A's handover, start watching only
  when a read (`next`, `whenPending`) actually blocks on the gate. If the counterpart has ended,
  the gate opens with nothing restored.
- B's failure path, waiting for A to take its hooks back, also stops if A ends.

**Never finalize after takeover.** A run that no longer owns the session must not finalize the
shared stream. Once A observes the takeover it only sends handover parts, which do not fail, and
exits as transferred; the original run still parks on its anchor. A takeover observed outside any
attempt cannot happen, since every forced claim belongs to one; if it does, A logs an error from a
step and leaves the same way rather than treating it as the inbox closing. If A's forced reclaim itself fails, A's session fails as any owner failure would,
and B, watching A, stops waiting and exits without writing to the stream.

### Successor (B)

1. **Fence duplicates.** B's first durable operation is an ordinary claim of
   `eve:handoff:lease:<attempt key>` with `experimental_minRetention: "7d"`. Relative retention
   starts when the hook is created; seven days is far beyond any queue delay and within the
   Postgres World's default 30-day cap. A duplicate from a retried start step, or a candidate whose
   owner already took the lease after a failed start step, conflicts and exits without touching
   session hooks or signaling. A `v3` input missing `attemptKey`, `hookTokens`, or `sourceRunId`
   is malformed and signals `failed` rather than taking the released path.
2. **Prepare in one step.** `prepareSuccessorStep` migrates the checkpoint, validates it,
   confirms A (`sourceRunId`) still holds every token in `hookTokens`, and records `$eve.version`.
   Recording must precede any claim, because ingress reads it. If validation fails, signal
   `incompatible` or `failed` and exit. If A no longer holds an address (A was cancelled or failed
   while B was queued, and a new session may reuse a channel alias), B claims nothing, signals
   `failed` (a no-op once A is gone), and exits. The source can still end between this check and
   the claims; that window is one step rather than a queue delay. Nothing was claimed, so A has
   nothing to recover.
3. **Force-claim A's hook set** (`hookTokens`) in one batch, arming the gate before any hook
   exists so a handover that is a hook's first payload is never dropped. B claims exactly A's set:
   forcing a token A never held could take it from an unrelated run, and A reclaims only its own
   set on failure. B's state cursor claims any other token it derives, ordinarily, at its first
   transition. No model or tool work happens until every claim settles. If any claim fails,
   signal `failed` (with `claimedHooks` when B holds any) and keep the pumps open until A
   reclaims, or until A ends. Then drain and send the leftovers back as a `handover`. Recovery is the same
   mechanism in the other direction.
4. **Run the triggering delivery immediately.** The inbox starts gated. Interrupt handlers
   (`cancel`, `reset`, timeout) still fire on arrival, but reads (`next`, `drain`, `takeLeading`,
   `hasPending`) expose nothing until A's `handover` for this attempt arrives. It is then placed
   where the gate was armed (the head, on a fresh successor), ahead of every direct arrival, so
   FIFO holds across the move. The gate holds every payload kind, so replies to B's own work
   (workflow-run messages, `runtime-action-result`) and accepted cancels are processed once the
   handover arrives; a cancel's interrupt still aborts B's running turn on arrival. The wait is
   bounded by A's side alone (its pumps close, then one step per leftover plus the final part), so
   it cannot deadlock on B; if A ends first, the counterpart watch opens the gate with nothing
   restored. Once no hook
   remains the gate can never open, so it is ignored and leftovers stay drainable.
5. **Session timeout.** The timeout is idle-based: B starts its idle window at boot, right after
   the delivery or compacting turn that moved the session, and arms its timer concurrently with
   the first turn.

`handover` is a runtime-only inbox payload, like `session-failure`. A sends it through the stable
session address, so the SDK's redirect delivers it to B. Channel request bodies cannot construct
it.

### Invariants

1. **One executing owner.** A runs no turn from `startSuccessorStep` until the attempt settles. B
   does no model or tool work until it owns every hook in the set.
2. **Continuous ownership.** Every address always has a live owner. Ingress never sees
   `HookNotFound` for a live session because of a handoff.
3. **FIFO, no loss.** Every payload accepted by A is processed before any payload accepted by B
   (the SDK orders the takeover after A's buffered deliveries, and B's gate holds everything it
   accepts until A's handover is in place). In-flight resumes redirect. Leftovers always travel in
   a `handover`, in either direction.
4. **No duplicated work.** The triggering delivery runs exactly once: on B if every claim
   succeeded, otherwise on A. Duplicate candidates lose the lease before they claim anything.
5. **Eligibility is unchanged.** Only a lone, callerless delivery to an idle session triggers a
   deployment handoff (`handoffEligible`). Messages arriving after A decides ride the handover;
   they never block or abandon the move. A backlog that already exists when A decides still
   keeps the session where it is.

## Compaction handoff

The latch and eligibility stay the same: after a compacting turn, with no delegated caller and no
working tasks. The trigger changes:

- The owner transfers only from the eager path, at the first boundary where nothing is queued.
  Deliveries no longer carry a compaction transfer. A message already waiting at that boundary
  runs on the current owner with no handoff cost, and the next quiet boundary moves the session.
- A message that arrives once the eager transfer has started is not a race any more. Whichever
  owner accepts it, it is processed on the successor after the handover, without a second
  attempt. Its added latency is bounded by the rest of one transfer.
- Starvation is no worse than today. The delivery-carried path also required a lone delivery, so
  a client that always queues during turns already deferred the move.

## Ingress

Owners using v3 never leave an address unowned, so `resumeSessionInbox` takes its normal path on
every handoff. The marker read path (`waitWhileHandoffInProgress`), `SessionHandoffPendingError`,
and the handoff-driven 409 `session_not_ready` stay only for owners still running a v2 build,
whose own handoff to a v3 deployment still releases first (see
[Compatibility](#compatibility)). That path is reached only after a `HookNotFound`, so it costs
nothing on a delivery. The `session_not_ready` reply for a session whose initial run has not
claimed its inbox yet is unrelated and stays.

## Compatibility

| Source → successor                                 | Behavior                                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v3 → v3                                            | Force-claim protocol.                                                                                                                                                                                      |
| v2 → v3 (first move after this ships)              | The source has already released and holds markers. B claims ordinarily, with no lease and no gate because no handover will come, and signals `active` in the v2 shape the source awaits.                   |
| v1/unversioned → v3                                | Same as v2.                                                                                                                                                                                                |
| v3 → successor on a build older than v3 (rollback) | The older successor's ordinary claim conflicts, so it signals `failed`. A remembers the deployment as incompatible and keeps the session, matching the documented rollback behavior for newer checkpoints. |
| Legacy driver import                               | Unchanged. Its ordinary claim conflict still means "another importer won".                                                                                                                                 |
| Stranded reset, `reset` release wait               | Wait until no run serving the same session (by the holder's hook metadata) holds the address, so a takeover mid-reset does not end the wait while the session lives on.                                    |
| World without `hookForceClaim`                     | `startSuccessorStep` starts nothing and returns `unsupported`; A stops attempting for its lifetime (`unsupported-world`). Sessions never move between runs, so their event logs grow with the session.     |

`SESSION_HANDOFF_VERSION` becomes 3. `SESSION_CHECKPOINT_VERSION` does not change, because the
state shape is untouched. `SessionOwnerActivation` keeps its shape; v3 sources rely on the
takeover instead of `active`.

## Expected critical path

| Path                        | Today                                                                 | v3                                                       |
| --------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Deployment handoff, on A    | idle step, anchor, markers, release step, activation hook, start step | `startSuccessorStep`                                     |
| Deployment handoff, on B    | validate step, record step, claim, signal step                        | lease, prepare step, force-claim                         |
| Durable operations in total | 10                                                                    | 4                                                        |
| Delivery during the move    | polls up to 5 s, then 409                                             | accepted at once; runs after the handover                |
| Compaction, racing reply    | abandon, reclaim, then a second full handoff                          | runs on the current owner, or after one bounded transfer |

The lease and the force-claim batch are single-hook or batched creations that Workflow 5.2
continues in-process, so each costs writes rather than a queue hop. The cross-deployment probe
and the successor's cold start remain. Both run before B's first step, and the probe warms the
target deployment.

## Rollout

1. **Baseline.** Not done yet. Add a handoff scenario to the `agent-workflow-stress` fixture that reports
   time-to-first-model-request after a compaction handoff through `EVE_WORKFLOW_STRESS_METRIC`.
   Record the hosted p50 and p95 on `main` before changing the protocol. Cross-deployment handoff
   cannot run in CI (one deployment), so measure it once by hand on two preview deployments.
2. **Inbox primitives.** `claimSessionHooks(tokens, { force, handover })`; pumps that treat
   `HookForceClaimedError` as a takeover rather than a failure, and `whenTakenOver()` once every
   hook is taken; the read gate and `handover` restore. Integration tests at the inbox boundary.
3. **Protocol v3.** `SessionHandoff`, `startSuccessorStep`, successor boot (lease, prepare,
   force-claim, gate), boot-time outcome and anchor hooks, the new compaction trigger, and v2
   successor compatibility. Delete markers and the release step from the owner side. Update
   [execution model and durability](../docs/concepts/execution-model-and-durability.mdx) (the
   compaction paragraph and handoff failure behavior). Add a `patch` changeset.
4. **Retire v2 compatibility, on evidence rather than a date.** Every session that is live when
   this ships is owned by a run on an earlier release, and it can reach current code only through
   a released handoff. The successor logs `session moved from an owner that releases its
   addresses first` each time it accepts one. Once production logs show none for a sustained
   period, a later release may delete the ingress marker path, `SessionHandoffPendingError`,
   `bootReleasedHandoffOwner`, and the marker token, as a deliberate breaking change in its
   changeset. Sessions with disabled timeouts (`sessionTimeoutMs: false`) can stay on an earlier
   owner indefinitely, so a fixed window would strand them. Track this in a follow-up issue
   opened alongside step 3 (not opened yet).

## Validation

Integration tier (`entry-handoff*.integration.test.ts`, rewritten around observable outcomes):

- deployment handoff runs the delivery on B, and the stream shows one `turn.started` for it.
- a delivery accepted by A after the start step is processed on B after the trigger, in order.
- a delivery sent to an alias at every point of the move resolves to the same session with
  `accepted`, and no `session_not_ready` is returned.
- B rejecting the checkpoint leaves A as owner with no reclaim, and A runs the delivery.
- B failing after partial claims: A reclaims everything, B's leftovers come back, and order holds.
- a duplicate candidate exits on the lease, with no hook changes and no turn.
- a v2-shaped source hands off to a v3 successor; a v3 source's attempt against a successor older
  than v3 is retained once and then skipped.
- compaction: a reply racing the eager transfer runs once, on the successor, with no second
  transfer attempt.

The local critical-path probe used for the baseline table (an integration test that timestamps
`world.events.create` and `world.queue`) is run once before and after to confirm the operation
count. It is not committed as a test.

E2E: extend `agent-cancellation/evals/cancellation/compact-session-handoff.eval.ts` with a reply
sent immediately after `session.waiting`, asserting one reply turn and an unbroken stream.

## Open questions

- **Lease overlap.** Claiming the lease in the same suspension as the prepare step removes one
  operation, but a `getConflict` awaiter disables inline execution for steps in that suspension.
  Measure both orders on hosted before choosing.
- **A handover part that never delivers.** Every part is retried until delivered or the session
  ends. A part that fails permanently therefore keeps the move retrying, and B gated, rather than
  dropping a message the session accepted. A only stops when the session has ended.
- **Watch cost.** No path creates a wait until something is actually blocked or waiting: input
  pending behind an open attempt (one sleep until the boot deadline), a gated read, or a candidate
  still live past the deadline. A watch then costs a wait plus a step every 10 s. A candidate that
  never boots holds the session's pending input for up to the boot deadline; whether to also
  cancel such a candidate is deferred. When a message races the move, the deadline sleep cannot
  be cancelled: after a retain it turns off Workflow's inline step delta for up to the boot
  deadline and wakes the run once with nothing to do (a parked original run also gets one extra
  replay).
- **Retirement signal.** The released-path log shows sessions that moved, not sessions that are
  still waiting on an earlier owner for their next message. Before retiring, decide whether the
  log's silence is enough, or whether to count remaining owners by `$eve.version` in the World.

## Upstream follow-ups

- `@workflow/world-local` 5.1 writes a force-claimed victim's `hook_disposed` without the
  victim's per-hook lock that `hook_received` takes. A resume that passed the disposal check just
  before the claim commits can append after the disposal row, where it is neither redirected nor
  delivered (the same class as vercel/workflow#2781, for a run's own disposal). Reported as
  [vercel/workflow#4923](https://github.com/vercel/workflow/issues/4923) and fixed in
  [vercel/workflow#4924](https://github.com/vercel/workflow/pull/4924). eve does not patch it:
  until it upgrades to a `@workflow/world-local` release with that fix, a delivery racing a
  forced claim on the local world can be lost, and the alias-delivery integration test that races
  the claim is skipped. `eve dev` runs on the local world, so a delivery racing a handoff after a
  dev reload is exposed to the same race until that upgrade. Upgrade and re-enable that test once
  the fix ships.
  `@workflow/world-postgres` 5.0.4 serializes the same pair with row locks in one transaction and
  is not affected.
- Let a cross-deployment `start()` skip or prefetch the capability probe when the caller already
  holds a fresh attestation, for example one stamped by ingress on the accepting deployment.
- A global stream independent of any run would let the original run stop parking as the anchor.
  This request predates this plan and is still open.
