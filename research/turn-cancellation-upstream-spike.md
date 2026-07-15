---
issue: https://github.com/vercel/eve/issues/483
last_updated: "2026-07-02"
status: complete
---

# Turn cancellation: upstream Workflow spike (layers 1–2 de-risk)

## Verdict

| Blocker                                                                     | Status on vendored `@workflow/core` 5.0.0-beta.26 | Consequence                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Duplicate step execution under one correlation id (layer-1 finalizer shape) | **Not reproduced — 5/5 clean**                    | **Layer 1 is unblocked. Proceed.**               |
| Hook token reuse after dispose, within one run                              | **Reproduced — 5/5 deterministic self-conflict**  | Layer 2 blocked for naive same-token designs     |
| Hook token reuse after dispose, across sequential runs                      | **Reproduced — 4/5 flaky conflict**               | Layer 2 blocked for session-scoped cancel tokens |

Layer 2 has two viable paths that do not wait on upstream: a verified
in-workflow barrier, and eve's existing indexed-token pattern (see
"Paths forward"). Upstream fixes remain worth filing; the event-log
evidence below is report-ready.

## Method

Integration-tier repros against a real `@workflow/world-local` world and the
production workflow bundle pipeline (same harness as
`workflow-entry.integration.test.ts`):

- fixtures: `packages/eve/src/internal/testing/cancellation-spike-workflow.ts`
- tests: `packages/eve/src/internal/testing/cancellation-spike.integration.test.ts`
- run: `pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/internal/testing/cancellation-spike.integration.test.ts`

Versions: `@workflow/core` 5.0.0-beta.26, `@workflow/world-local`
5.0.0-beta.22 (test world), `@workflow/world` 5.0.0-beta.14. Results below are
from 5+ consecutive suite invocations.

## Finding 1: the layer-1 shape works end to end (5/5)

The exact mechanics layer 1 needs, in one workflow:

```ts
const controller = new AbortController();            // durable, hook-backed in the workflow VM
const cancelHook = createHook({ token: `${workflowRunId}:spike-cancel` });
const stepPromise = spikeWaitStep({ abortSignal: controller.signal, ... });
const winner = await Promise.race([stepPromise, cancelIterator.next()]);
// hook wins → controller.abort(reason) → in-flight step's signal aborts in real time
await stepPromise;            // settles (return or FatalError throw)
await spikeFinalizerStep();   // the cancelled-turn epilogue stand-in
```

Verified, deterministically, in both step-settlement modes (return-on-abort and
throw-`FatalError`-on-abort):

- the serialized `AbortSignal` crosses the `"use step"` boundary and aborts the
  **in-flight** step in real time (abort stream, not just replay state);
- the raced-and-abandoned hook read does not corrupt the run;
- the finalizer step executes **exactly once** (asserted two ways: step
  side-effect log lines, and an event-log scan proving no correlation id
  records more than one `step_started`);
- the workflow completes with the expected return value; no retries fire for
  the aborted step.

The #347-era "duplicate finalizer-step execution" does not reproduce under the
planned layer-1 shape. Residual risk: #347's failure was observed in the full
turnWorkflow (runtime-action waits, world-postgres in CI); layer 1's PR should
keep the `expectNoDuplicateStepStarts`-style assertion in its integration
tests as a canary.

Implementation notes captured for layer 1:

- `FatalError` prefixes its name into the propagated message
  (`"FatalError: <msg>"`); match cancellation by a stable marker, never by
  exact message equality (consistent with layer 0's name-based
  `TurnCancelledError` matching).
- Workflow-VM errors fail `instanceof Error` in test code (cross-realm);
  inspect `error.name` via property access.

## Finding 2: same-token hook reuse within one run self-conflicts (5/5)

Shape: `createHook(T)` → receive → `iterator.return()` → `dispose()` →
`createHook(T)` again in the next loop iteration (the naive per-turn
`${continuationToken}:cancel` cycle). Round 1 fails every time:

```text
HookConflictError: Hook token "wrun_…:spike-reuse" is already in use by
another workflow (run "wrun_…")        ← conflictingRunId = the same run
```

Event-log smoking gun (one run, chronological):

```text
hook_created   corr=…RM01  token …:spike-reuse
hook_received  corr=…RM01  token …:spike-reuse
hook_conflict  corr=…RM02  token …:spike-reuse  conflictingRunId=<same run>
hook_disposed  corr=…RM01  token …:spike-reuse
```

Workflow code called `dispose()` on hook RM01 **before** creating RM02, yet
the engine validated RM02's registration before persisting RM01's disposal —
`hook_conflict` lands ahead of `hook_disposed` in the same run's log. The
suspension flush orders same-suspension hook creations ahead of pending
disposals (or storage claims are checked before disposal intents drain).

This is distinct from (and survives the fix for) upstream
[workflow#2283](https://github.com/vercel/workflow/issues/2283), which made
duplicate processing of the _same_ `hook_created` idempotent. Here two
_different_ hooks reuse one token across a dispose that the engine reorders.

## Finding 3: cross-run token reclaim races dispose persistence (4/5)

Shape: run N claims token T (via `getConflict()`), receives one payload,
disposes, completes; run N+1 starts immediately and claims T. Five rounds per
test; failed 4 of 5 invocations, at varying rounds:

```text
run A: hook_created → hook_received → hook_disposed   (all persisted, in order)
run B: hook_conflict  token T  conflictingRunId=<run A>
```

Run A's `hook_disposed` event exists, but run B's claim still conflicts
against A — the world's token-claim constraint is not released in the same
ordering domain as the disposal event, so a fast next claimant observes a
stale claim. This is the exact "fast descendant resumes" timing eve already
documents at `packages/eve/src/execution/workflow-entry.ts:162-166`.

## Paths forward

**Layer 1 (proceed now).** Durable `AbortController` in `turnWorkflow`, cancel
race, cancelled-turn finalizer, `turn.cancelled` → `session.waiting`. No
upstream dependency. Plug into the layer-0 seam (`TurnStepInput.abortSignal`).
Layer 1 creates its cancel observation hook once per turnWorkflow run with a
run-scoped token — no token reuse, so findings 2–3 do not apply.

**Layer 2 (two upstream-independent options, in preference order):**

1. **Indexed per-turn cancel tokens** — `${sessionId}:cancel:${turnIndex}`,
   mirroring the existing turn-control token workaround. No token is ever
   reused, sidestepping both repros entirely. The HTTP cancel route must
   discover the active index; the driver already stamps `$eve.*` run
   attributes, which can carry the live turn index/token.
2. **Barrier after dispose** — a `"use step"` suspension between `dispose()`
   and the next same-token `createHook` flushes the disposal (verified 3/3
   green in the spike's `interposeStep` variant). Works within one run;
   does **not** help the cross-run race, so it only suits designs where one
   long-lived run owns the token.

**Upstream (filed; do not block on them):**

1. [workflow#2777](https://github.com/vercel/workflow/issues/2777) — same-run
   suspension flush must order `hook_disposed` ahead of subsequent same-token
   `hook_created` validation (finding 2).
2. [workflow#2778](https://github.com/vercel/workflow/issues/2778) —
   token-claim release must be atomic/ordered with `hook_disposed`
   persistence so a new claimant cannot conflict against an already-disposed
   hook (finding 3).

## Spike artifacts

Throwaway; not merged. If kept, convert findings 2–3 tests to `it.fails` so
they self-signal when upstream fixes land, and keep the layer-1 tests as
permanent regression coverage for the layer-1 PR.

- `packages/eve/src/internal/testing/cancellation-spike-workflow.ts`
- `packages/eve/src/internal/testing/cancellation-spike.integration.test.ts`
