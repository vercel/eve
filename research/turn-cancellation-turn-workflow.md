---
issue: https://github.com/vercel/eve/issues/483
status: in-review
last_updated: "2026-07-13"
---

# Turn cancellation, layer 1: turn-workflow ownership

> **Ship status: unblocked** (eve#573). The `e2e-local` stress suite had
> exposed that serializing the durable `AbortSignal` into `turnStep` cost
> ~0.5 s fixed per step on world-local and opened an abort-stream tail
> reader whose 100 ms polling did a full `readdir` of the world-global
> chunks directory — a 100-turn session compounded from ~0.9 s/turn into
> a 240 s replay timeout (the Vercel world was unaffected). Filed as
> [workflow#2795](https://github.com/vercel/workflow/issues/2795) (fixed
> cost) and
> [workflow#2797](https://github.com/vercel/workflow/issues/2797)
> (scaling); both fixed upstream by
> [workflow#2807](https://github.com/vercel/workflow/pull/2807)
> (`executeStep` cancels abort readers post-step; chunks sharded
> per-stream), shipped in `@workflow/core` 5.0.0-beta.28 /
> `@workflow/world-local` 5.0.0-beta.24 and vendored into eve by #612.
> Re-benched on the fixed runtime: 40 sequential signal-bearing turns run
> at the ~385 ms no-signal floor with no compounding.

## Summary

Layer 0 (#494) made the harness honor an `AbortSignal` end to end but left
`TurnStepInput.abortSignal` unpopulated. Layer 1 makes the turn cancellable
in-process: the turn-owned `turnWorkflow` claims a durable session-scoped
cancel hook (`{sessionId}:cancel`) and a durable `AbortController`, and
resuming the hook mid-turn settles the turn as `turn.cancelled` →
`session.waiting` — never as a failure. The payload's optional `turnId`
guard scopes a cancel to the turn the caller observed. No HTTP route,
client API, or channel surface exists yet (layer 2); the only trigger is
resuming the cancel hook, which tests do directly.

## Cancellation semantics (as shipped)

- **Trigger**: `resumeHook("${sessionId}:cancel", { turnId? })`. The cancel
  token is **session-scoped and stable**, so a layer-2 trigger derives it
  from the session id alone — no per-turn token discovery, no client-carried
  hook token. Each turn workflow run creates and claims the token at turn
  start and disposes it before publishing its turn result, so at most one
  live cancel hook exists per session and the next turn's claim never races
  the prior run's teardown. A claim conflict (residue of a crashed prior
  turn whose hooks are not yet swept) degrades that turn to uncancellable
  rather than failing it. The hook payload carries no caller-supplied
  reason: layer 1 uses one canonical cancellation reason (the layer-0
  `TurnCancelledError`), and caller reasons arrive with the trigger surface
  in layer 2.
- **Turn guard**: the payload's optional `turnId` scopes the cancel to the
  turn the caller observed (every stream event is stamped with its
  `turnId`). A guard naming any other turn is consumed as a benign no-op —
  a cancel that races a turn boundary can never kill a turn the caller
  never saw. Omitting `turnId` cancels whatever turn is currently running,
  the right default for a plain stop button. Guard reads are durable hook
  reads, so the skip sequence replays deterministically.
- **Cancel during model/tool work**: the durable signal (threaded through
  `TurnStepInput.abortSignal`, the layer-0 seam) aborts the in-flight harness
  work in real time. The turn settles with `turn.cancelled` followed by
  `session.waiting` on the session stream (stream version 19), and the
  session accepts the next message normally.
- **Cancel is not failure.** A cancelled turn never emits `turn.failed`,
  `step.failed`, or `session.failed`, and the aborted `turnStep` is never
  retried as a failure. Pinned by tests; this is the invariant that leaked
  in #347.
- **Cancel during an in-line runtime-action wait** (subagent / dynamic
  workflow results): the wait stops and the turn settles cancelled the same
  way. The pending runtime-action batch and workflow interrupt are dropped
  at settle time (their tool-call exchange lives inside the batch and never
  reached history; replaying them would re-dispatch the actions).
  Descendants are _not_ cascaded to (layer 3); their late results land on
  the dead turn inbox and are dropped.
- **Cancel after the turn settled (or before it starts)**: benign no-op —
  the settle disposed the session cancel hook, so a late resume rejects
  with `HookNotFoundError`. Duplicate and same-instant cancels are also
  safe without trigger-side single-flighting: a duplicate resume neither
  re-dispatches the in-flight step (workflow#2848) nor corrupts replay
  when racing disposal (workflow#2808). Layer 2 only needs to treat
  "already resumed/disposed" as success.
- **Partial content is kept.** Whatever the harness emitted before the abort
  stays on the stream, and durable history persists exactly what the harness
  had settled at abort time — no rollback, no synthesis.
- **Cancellation is driver-negotiated and parkable-only.** The pinned driver
  body advertises `cancelledTurnSettle` through the dispatch input; the turn
  workflow registers the cancel hook only when it is set _and_ the session
  can park (conversation mode, or an anchored continuation token — delegated
  children always have one). Drivers pinned before the capability get no
  cancel hook, so a layer-2 trigger cannot strand them with an unsettled
  cancelled park; unparkable root task runs get no hook, so cancellation can
  never decay into `session.failed`. Task-mode terminal semantics arrive
  with layer 2.
- **Cancel during a descendant HITL wait**: the proxy epilogue has already
  streamed the turn's waiting boundary, so the settle emits nothing extra
  (no fabricated turn id, no duplicate `session.waiting`) and clears the
  proxy input-request map — later HITL answers stay with the parent instead
  of routing to the orphaned child.
- **The settle epilogue runs the authored-hook pipeline.** `turn.cancelled`
  and its `session.waiting` dispatch stream-event hooks like any turn-step
  emission.
- **Parked sessions cannot be cancelled** in this layer: parking terminates
  the turn workflow, so there is no turn to cancel. The session-scoped story
  stays in `research/channel-session-reset.md`.
- **The legacy (non-turn-inbox) workflow path is untouched.**

## Data flow (as shipped)

```text
test / (layer 2 route)          resumeHook(`${sessionId}:cancel`, { turnId? })
        │
turnWorkflow                    execution/turn-workflow.ts
  control = createTurnCancellationControl({ sessionId, expectedTurnId })
        │  claims the stable session token; a conflict (stale prior-turn
        │  claim) degrades the turn to uncancellable instead of failing
        │  mismatched turnId guards are consumed as durable no-op reads
        │  the hook-read continuation aborts the durable controller —
        │  replay-deterministic (keyed to the hook_received event), no
        │  promise race decides whether abort() runs
        ▼
  turnStep (awaited plainly)    execution/workflow-steps.ts
    harness aborts (layer 0) → TurnCancelledError
    → returns { action: "cancelled" }   pure marker, no side effects
        │
  cursor.finish(…, { cancelled: true, kind: "park" })
        │                       park arm reused: new NextDriverAction arms
        │                       break pinned drivers; optional fields don't
        ▼
workflowEntry driver            execution/workflow-entry.ts
  settleCancelledTurnStep       execution/settle-cancelled-turn-step.ts
    emits turn.cancelled → session.waiting, clears pending batch/interrupt,
    persists the between-turns session
  then the normal park playbook: rekey, await the next message
```

Within `waitForRuntimeActionResults`, the inbox read is raced against the
cancel-hook read; a cancel releases any raced public delivery back to the
driver (`turn-delivery-cancelled`) and loops into one final `turnStep`,
which observes the aborted signal at entry (before the park-resume stages,
which would otherwise re-park on the still-pending batch) and settles
through the same cancelled arm.

## Where the shipped design deviates from the proposal

Integration against the real runtime (vendored `@workflow/core`
5.0.0-beta.26) surfaced behaviors that reshaped the epilogue path. This
section is historical: the runtime defects cited below (#2780, #2781)
have since been fixed upstream — see "Runtime findings" for the fixes
and which mitigations remain load-bearing:

1. **No workflow-side race; abort in the hook-read continuation.** The
   durable `abort()` writes a hook event, and the upstream contract
   ("`abort()` becomes a no-op on replay") presumes the call site is
   reached deterministically on every replay — gating it behind a
   `Promise.race` winner makes that reachability replay-dependent. The
   abort now fires in the `.then` of the cancel-hook read itself, keyed to
   the `hook_received` event. (The corruption initially attributed to this
   shape was later traced to workflow#2781; the deterministic call site is
   kept as contract hygiene.)
2. **`turnStep`'s cancelled result is a pure marker.** The runtime can
   supersede an aborted step attempt and re-dispatch it under the same
   correlation id, with both attempts running to completion in-process
   (at-least-once inline execution, workflow#2780). Any cancel-path side
   effect inside `turnStep` — including the epilogue — can therefore
   duplicate.
3. **The epilogue runs in the _driver_, not the turn run.** Queued
   cancel-payload and abort-hook wakes re-dispatch in-flight steps of the
   turn run; the driver's wake sources exclude the cancel hook. The driver
   recognizes `park` + `cancelled: true` and runs `settleCancelledTurnStep`
   before the normal park playbook. (Old pinned drivers ignore the marker
   and simply park — harmless, since no cancel trigger predates them.)
4. **Turn control hooks are disposed one turn late.** The turn run's final
   control send is at-least-once (workflow#2780); a late duplicate resume
   on a _disposed_ hook is accepted and logged by the world and then
   diverges the driver's replay (workflow#2781).
   `dispatchAndAwaitTurn` now returns a deferred `dispose()` that
   the driver invokes when the _next_ turn settles (or the session ends),
   by which time the previous turn's run has completed and cannot re-send.
5. **Turn-run teardown is dispose-only — never `iterator.return()`.** The
   cancel hook always has an outstanding durable read (the abort
   continuation), and an async generator honors `return()` only after its
   in-flight `await` settles — never, for a turn that wasn't cancelled.
   Closing the iterator therefore suspends the turn run forever: it never
   reaches `run_completed`, so the world never sweeps its hooks, leaking
   one running run and three hooks (inbox, cancel, durable-abort) per
   turn, and `getByToken`'s O(live hooks) scan slows every resume in the
   session. Hook disposal alone is the runtime's sanctioned pattern:
   pending reads are dropped and the run proceeds to completion, where
   terminal-run cleanup deletes the run's hooks.

## Runtime findings (filed upstream)

Observed against `@workflow/world-local` during integration testing and
re-validated with standalone spike repros before filing:

- **[workflow#2780](https://github.com/vercel/workflow/issues/2780)** —
  at-least-once inline step execution under wakes: a `hook_received` that
  lands while a step attempt is in flight re-dispatches the step under the
  same correlation id; both attempts run concurrently in-process and both
  flush side effects (only one `step_completed` is recorded). Standalone
  repro deterministic (4/4). Complement to workflow#2777/#2778.
  **Fixed** by [workflow#2848](https://github.com/vercel/workflow/pull/2848)
  (`@workflow/core` 5.0.0-beta.30): inline steps are stamped with the
  owning queue message id, wake replays schedule a delayed backstop
  (lease-bounded) instead of immediately re-dispatching an in-flight step,
  and an upstream in-process single-flight collapses racing attempts. The
  residual is the queue's ordinary at-least-once envelope (redelivery of
  the owning message while the step is alive; cross-instance duplicates
  post-lease).
- **[workflow#2781](https://github.com/vercel/workflow/issues/2781)** —
  a `resumeHook` racing hook disposal is accepted and journaled after
  `hook_disposed`; the owning run's replay then deterministically diverges
  at that event (`REPLAY_DIVERGENCE`, escalating to
  `CorruptedEventLogError`). The duplicate resume that hit the window came
  from a #2780-style re-executed step. The acceptance window is
  timing-dependent (a simplified standalone repro produced the duplicate
  resume but landed it after disposal enforcement); the journal-level
  evidence is unambiguous.
  **Fixed** by [workflow#2808](https://github.com/vercel/workflow/pull/2808)
  (`@workflow/world-local` 5.0.0-beta.24): `hook_received` acceptance is
  serialized against the per-hook dispose lock and re-validated before
  the event append, so a resume ordering after disposal is rejected with
  `HookNotFoundError` instead of corrupting the owner's replay. Two
  caveats: the fix is acceptance-side only (a bad order already journaled
  before it still diverges on replay), and it ships in world-local — the
  hosted Vercel world's parity is unconfirmed.
- **Not filed — falsified in isolation**: an earlier hypothesis that
  reaching `abort()` behind a promise-race winner corrupts the event log
  did not reproduce standalone (5/5 clean); every corruption we observed
  traced to #2781. The abort-in-hook-continuation shape is kept anyway as
  determinism hygiene: the upstream abort-controller contract ("`abort()`
  becomes a no-op on replay") presumes the call site is reached on every
  replay, and the duplicate `abrt` `hook_received` we logged under wake
  storms adds wakes that feed #2780's preconditions.

Upstream status (all four findings are now fixed in the runtime this
branch vendors — `@workflow/core` 5.0.0-beta.31, `@workflow/world-local`
5.0.0-beta.27):

- [workflow#2779](https://github.com/vercel/workflow/pull/2779) fixed
  #2777/#2778 (suspension-handler per-token ordering; world-local claim
  release).
- [workflow#2808](https://github.com/vercel/workflow/pull/2808) closed
  #2781's remaining acceptance window (world-local).
- [workflow#2848](https://github.com/vercel/workflow/pull/2848) fixed
  #2780 (inline step message ownership).

Consequences for layer 1's mitigations:

- The `settleCancelledTurnStep` in-process single-flight it originally
  carried became redundant with the upstream one and was removed; the
  queue's residual at-least-once envelope can duplicate the epilogue,
  like every stream emission under crash retry.
- Deferred control-hook disposal stays: `sendTurnControlStep` does not
  treat `HookNotFoundError` as benign, so a rare crash-retry duplicate of
  the final control send against an already-disposed hook would surface
  as a turn error, and hosted-world parity for the #2808 acceptance fix
  is unconfirmed. Both are addressable in a follow-up if immediate
  disposal is worth it.
- The driver-owned epilogue, the pure `cancelled` marker, the
  abort-in-hook-continuation shape, and dispose-only teardown all stand
  on rationale independent of the fixed bugs (wake-source isolation,
  at-least-once side-effect hygiene, replay determinism, async-generator
  semantics) and are unchanged.

Consequences for layer 2 (relaxations from the earlier guidance):

- Strict per-turn single-flighting of cancel resumes is no longer
  required: a duplicate resume neither spawns a concurrent step attempt
  (#2848) nor corrupts replay when racing disposal (#2808). Treating
  "already resumed/disposed" as success is sufficient.
- These fixes made a stable session-scoped cancel token viable (#2779
  makes the dispose-then-recreate claim shape safe across consecutive
  runs; #2808 removes the disposal race), and layer 1 **adopted it**:
  the shipped token is `{sessionId}:cancel` with an optional `turnId`
  payload guard. Layer 2's route is therefore pure derivation —
  `POST /eve/v1/session/:id/cancel` resumes `{sessionId}:cancel`,
  forwards the caller's optional `turnId`, and maps `HookNotFoundError`
  (no turn in flight) to a "nothing to cancel" success.

## Invariants (pinned by tests)

1. An aborted `turnStep` settles by return value; no thrown cancellation
   crosses the step boundary — the turn workflow run records no
   `step_failed`/`step_retrying` events and at most one `step_completed`
   per correlation id.
2. `turn.cancelled` is emitted once per cancelled turn under normal
   operation (at-least-once under crash retry, like every stream
   emission), always followed by
   `session.waiting`; zero failure events on the cancelled path; the aborted
   tool executes once; the cancelled turn streams one `step.started`.
3. The cancel hook token is session-scoped and never doubly live: each
   turn workflow run claims `{sessionId}:cancel` at turn start and
   disposes it before publishing its turn result, so the next turn's
   claim never races the prior run's teardown. A conflicting stale claim
   degrades the turn to uncancellable, never to a failure.
4. A cancelled subagent wait is not re-dispatched: the next turn runs
   normally with no `subagent.called`.
5. With no cancel resumption, behavior is unchanged (all pre-existing unit
   and integration suites pass).

## Testing

- **Integration** (`execution/turn-cancellation.integration.test.ts`): real
  `workflowEntry` + `turnWorkflow` over world-local with a hanging
  `wait_for_cancel` tool; covers mid-tool cancel (with a matching `turnId`
  guard) + follow-up turn, a stale-guard cancel consumed as a no-op with
  the turn still cancellable afterwards, cancel during an in-flight
  subagent wait (via the mock model's `Delegate to a subagent: …`
  directive) + no re-dispatch, late/duplicate cancel no-ops, the no-retry
  canary, and cancel-hook sweep after each settle.
- **Unit**: `createTurnCancellationControl` (token derivation, claim
  conflict → uncancellable, guard matching and stale-guard skip,
  idempotent disposal), cancelled-turn arm of `turnWorkflow` (park +
  `cancelled` marker, `canPark` bypass, signal threading,
  dispose-before-result ordering), deferred control-hook disposal,
  `activeTurnId`, `emitCancelledTurn` (event order, turn-id
  reconstruction, state advance), `createTurnCancelledEvent`,
  stream-version pin.
- **E2E stays shelved** until layer 2 provides an HTTP trigger.

## Out of scope

- `POST /eve/v1/session/:id/cancel`, caller-supplied cancellation reasons,
  channel/client/eval APIs (layers 2 and 4). No token discovery is needed:
  the route derives `{sessionId}:cancel` directly.
- Descendant cascade — local subagent inbox propagation and remote cancel
  (layer 3). Layer 1 only discards their late results.
- Cancelling parked sessions or session-scoped cancellation
  (`research/channel-session-reset.md`).
- The legacy non-turn-inbox workflow path.

## Delivery

Shipped in one PR with a **patch** changeset (additive `turn.cancelled`
protocol event, stream version 18 → 19; no breaking public API). Scope
decisions settled at review: the runtime-action wait arm is **in**, and the
cancellation reason is canonical-only until layer 2.
