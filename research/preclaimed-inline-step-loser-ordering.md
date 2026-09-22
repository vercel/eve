---
issue: "TBD (follow-up to the P1 review on vercel/workflow#4254)"
status: proposed
last_updated: "2026-09-21"
---

# Preclaimed inline-step loser ordering

## Summary

Eve vendors a Node-runtime patch that runs every inline step through Workflow's
process-wide single-flight guard. This prevents a local queued wake from
executing a fresh inline step body again while its first execution is live.

That broader guard has one incompatible input: a batched inline preclaim whose
result is `preclaimedStart.owned === false`. The World has already decided that
this replay lost the atomic create-and-claim race. It must reach `executeStep`,
which returns `skipped`, without first occupying the single-flight slot.
Otherwise a losing replay can enter the slot before the actual owner; the owner
then waits and returns `skipped` too. The durable step remains running without
its body having run. A later recovery normally repairs it, but a step with
`maxRetries: 0` can be failed before its user code ever runs.

The upstream review that identified this ordering is
[vercel/workflow#4254, P1](https://github.com/vercel/workflow/pull/4254#discussion_r4051007919).
It is not part of the logging-only change in eve PR #3608.

## Scope and invariant

The correction applies only to this state:

```ts
s.preclaimedStart?.owned === false;
```

For that state, preserve Workflow's normal executor path and do not call
`runStepSingleFlight`. For every other inline step, retain eve's stronger
single-flight behavior:

- fresh lazy and successfully preclaimed steps use the guard and classify
  expected contention as `debug`;
- owned recovery steps use the guard and retain `warn` logging;
- queue-driven background steps are unchanged.

This only occurs when a World supports `events.createBatch` and the suspension
batch creates inline `step_created` + `step_started` pairs. The stock local and
Postgres Worlds do not implement that batch path. The production Vercel World,
and a custom World with the same capability, can produce it.

## Implementation

Extend the existing `guardInlineStepExecution()` replacement in
`packages/eve/scripts/vendor-compiled/@workflow/core.mjs` after the
logging-only PR has landed:

```ts
const fresh = s.lazyStepInput !== undefined || s.preclaimedStart !== undefined;
const executed =
  s.preclaimedStart?.owned === false
    ? run()
    : runStepSingleFlight(runId, s.correlationId, run, fresh ? "debug" : "warn");
```

`run()` is safe for the false branch: upstream `executeStep` checks the
preclaim verdict before starting or executing the step body and returns its
ordinary skipped result. Do not alter the World claim protocol, retry policy,
lease duration, acknowledgement behavior, or the upstream runtime's Node
single-flight policy.

Keep the vendoring guard's source-shape check strict enough to fail on a future
Workflow runtime shape change rather than silently omitting the correction.

## Regression coverage

Add two layers of coverage in the follow-up PR.

1. **Vendoring contract test.** Make the inline-step transform independently
   testable and feed it the beta.55 Node call-site fixture. Assert the generated
   code bypasses single-flight only for `preclaimedStart?.owned === false`,
   continues to route an owned preclaim through it, and retains the
   fresh-`debug`/recovery-`warn` classification. This is deterministic and
   catches a future dependency bump or a broadening/narrowing of the patch.

2. **Behavioral owner/loser regression.** Exercise the transformed runtime with
   two same-process inline executions for one correlation ID. Arrange the
   preclaim loser to enter first and remain pending until the owner arrives;
   then assert the owner executes its body exactly once and the loser resolves
   skipped. Repeat with `maxRetries: 0` to prove the owner is not converted into
   recovery and failed without running. The test must control this ordering; a
   real Vercel deployment race alone is not a reliable regression.

If the behavioral harness cannot instantiate the vendored runtime without
reimplementing Workflow internals, add this exact deterministic test upstream
in `@workflow/core` alongside a small helper that accepts the preclaim verdict,
then consume that released helper from eve's vendoring patch. Do not replace it
with a timing-dependent deployed test.

## Out of scope

- The fresh-inline logging suppression already covered by eve PR #3608.
- Cross-process duplicate execution, durable ownership, lease tuning, or queue
  scheduling.
- Enabling batched preclaims on local or Postgres Worlds.
- Changing public eve APIs or configuration.
