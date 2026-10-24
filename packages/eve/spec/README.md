# Checking the session scheduler

The production scheduler is pure: `on(state, event)` records what happened, and
`next(state, reading)` decides what the session asks the host to do. The session
loop performs those asks through the existing durable steps.

The checks here were ported from #4975 onto the current runtime. Their results
must be established on this base; old state counts and comparison digests do not
transfer with the source.

## The bounded checker

`src/internal/testing/scheduler-checker.ts` explores production `next` and `on`
breadth first. Its world models the durable facts and private records the
scheduler reads, supplies plain `SessionReading` values, and branches on step
results, arrivals, routing, handoffs, and idle-timeout checks.

Nine cases cover a core of Alice and Bob writing and answering, plus controls,
sign-ins, tasks and absolute task-wait deadlines, children, delegated callers,
queued messages, budgets, handoffs, session completion, and response policies.

The checker asserts that the scheduler:

- holds each delivery once and releases it before a step takes it;
- routes answers to children before taking the remainder;
- exposes held input before waiting;
- lets only the turn's caller steer;
- never sleeps through input or results it can take;
- waits only on open interactions, outstanding calls, working tasks, or valid task deadlines;
- resumes sign-ins only after all required callbacks;
- settles controls and tells delegated callers once;
- signals cancellation consistently with the decision it later takes;
- reaches a host ask without throwing or deciding forever;
- can reach a quiet state from every explored state.

Before `session.started`, a prewarmed session cannot publish control settlements.
The checker permits those settlements only while the scheduler explicitly retains
them in `unstarted`; it does not treat an unrecorded, dropped control as settled.
The first-step/terminal publication boundary remains a host integration concern.

From the repository root:

```sh
pnpm --filter eve exec vitest run --config vitest.integration.config.ts \
  src/execution/session/scheduler/checked.integration.test.ts
```

Use `-t 'controls'` to select a case. `EVE_CHECK_SCHEDULER_WIDEN=1` raises the
bounds. Run expensive checker and explorer cases serially.

## Negative controls and comparisons

```sh
pnpm spec:scheduler-mutants
```

The mutation runner introduces twelve faults into production source, one at a
time, runs the case that should detect each fault, and restores the source in a
`finally` block. A compile error or unrelated test failure is not a detected
fault: the run must report a checker finding. Do not edit source or run another
test process in the checkout while mutations are running.

To compare scheduler observations, record each revision in its own checkout:

```sh
EVE_CHECK_SCHEDULER_OBSERVE=/tmp/before pnpm --filter eve exec vitest run \
  --config vitest.integration.config.ts \
  src/execution/session/scheduler/checked.integration.test.ts
# Repeat on the other revision with EVE_CHECK_SCHEDULER_OBSERVE=/tmp/after.
pnpm spec:scheduler-compare /tmp/before /tmp/after
```

The tool compares the observations and reports shortest trails to differences.
It compares behavior within the world's bounds, not source structure.

## The real-harness explorer

`src/internal/testing/session-explorer.ts` combines the production scheduler with
the native harness and engine adapter. It uses deterministic model moves and
inline, approval-gated, response-policy, and simulated workflow tools. Its sink
uses production cascade, stream validation, and fold logic. It compares complete
and operational retention through the current selectors.

At each real step it checks the contract assumed by the bounded checker: inputs
are admitted, answers stand or remain pending for a legitimate reason, steering
withdraws the earlier requests, and clear closes its turn. It also probes batches,
stale answers, and combined answers/messages through production answer intake.
Every transition reads the live publication fold; there is no independent `Plan`
projection deciding subsequent transitions.

```sh
pnpm --filter eve exec vitest run --config vitest.integration.config.ts \
  src/execution/session/explored-sessions.integration.test.ts
```

The first test explores every path to a fixed depth and drains its leaves. The
second expands abstract states to a fixpoint, checks a second representative for
behavioral equivalence, and requires every state to reach a quiet one.
`EVE_EXPLORE_DEPTH`, `EVE_EXPLORE_CONTROLS=1`, and
`EVE_EXPLORE_DURING_STEP=1` expand the explored world.

`reachable-states.integration.test.ts` supplies a separate seeded driver over
actual Workflow sessions. It covers host signals and delivery interleavings that
the in-memory explorer does not execute.

## Limits

These are bounded checks over explicit worlds, not a proof for arbitrary numbers
of deliveries or users. The explorer does not cover sign-ins, tasks, children,
delegated callers, budgets, or handoffs; those checker contracts also need their
existing owner-boundary integration tests.

The checker does not execute host signals, durable timers, storage, or Workflow
serialization. The explorer simulates workflow dispatch/results rather than
starting external runs. Neither establishes crash safety, overlapping retry
safety, replay-free recovery, or general foreign-engine support. The opaque-engine
approval integration remains a separate, restricted demonstration.
