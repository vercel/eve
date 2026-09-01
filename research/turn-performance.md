---
issue: https://github.com/vercel/eve/issues/876
status: proposed
last_updated: "2026-09-01"
---

# Turn performance and Workflow overhead

## Summary

eve's hosted turn latency is a product problem, not a model-speed problem. The deterministic
Vercel Workflow stress fixture currently takes about 3.1 seconds per sequential turn on the
existing Workflow SDK, while production reports show 3.5–7 seconds before a model step starts.
Local profiling reaches the same directional conclusion: a warm mock `turnStep` takes about
50 ms, but the observed follow-up path takes about 353 ms, with 86% of that time outside the
model/tool step.

The fixed cost comes from the durable topology. An ordinary root turn starts a child Workflow
run, crosses five explicit step boundaries for full settlement, creates private hooks, writes
8–9 stream chunks, resumes the session driver twice, and carries the full session snapshot
through multiple persisted values. Two of those steps perform no work for a root session. Every
additional model/tool cycle schedules another `turnStep` and awaits another Workflow attributes
write.

This proposal makes performance measurable before changing the topology, then tests three levels
of improvement:

1. remove unnecessary steps and observability writes from the critical path;
2. reduce per-turn child-run, hook, stream-write, and state-transfer overhead;
3. prototype a bounded run-per-turn architecture that preserves durable session semantics without
   replaying one ever-growing driver run.

The first tracking increment lands with this plan: the existing stress fixture emits raw
machine-readable samples for sequential and concurrent turns, CI publishes a GitHub job summary,
and successful runs retain the report and eval artifacts for 30 days. Those measurements are
informational until paired base/head trials establish the hosted noise floor.

## Observed baseline

The current stress fixture uses a synchronous deterministic mock model, so its latency is almost
entirely eve and Workflow overhead. Recent unchanged/main-equivalent Vercel runs cluster at:

| Metric                                                 |     Observed range |
| ------------------------------------------------------ | -----------------: |
| Mean, 100 sequential turns                             |        3.08–3.19 s |
| p50                                                    |        3.02–3.14 s |
| p95                                                    |        3.82–3.94 s |
| Mean, turns 1–10                                       |        2.42–2.75 s |
| Mean, turns 91–100                                     |        3.58–3.75 s |
| Sequential turn-order slope in two representative runs | +13.6–14.6 ms/turn |

Representative GitHub runs are
[`33449386170`](https://github.com/vercel/eve/actions/runs/33449386170) and
[`33445215572`](https://github.com/vercel/eve/actions/runs/33445215572).

The turn-order slope is correlated with history depth but does not identify its cause: history,
event-log growth, queue drift, changing hosted load, and warming all move with sequential test
order. It makes the trend visible; only an interleaved benchmark over independently pre-seeded
history depths can call the resulting coefficient a history-depth slope.

The Workflow dependency update in
[PR #2611](https://github.com/vercel/eve/pull/2611) produced two runs near 4.91 seconds mean,
5.05–5.20 seconds p50, and 6.44–6.52 seconds p95. That is a useful demonstration that this fixture
can expose a material regression, but it is correlation rather than causal proof: the runs were
not an interleaved base/head experiment, and the upgrade changed several aligned Workflow
packages. The beta.47 change that persists `hook_received` before publishing a wake is a leading
hypothesis because eve resumes two hot-path hooks per turn; it needs an isolated SDK A/B.
[The Workflow change](https://github.com/vercel/workflow/pull/3841) explicitly adds one
producer-side event-write round trip but expects end-to-end time-to-resume to remain approximately
neutral because the consumer no longer performs the corresponding ensure write.

Customer evidence is consistent with the stress fixture:

- [Issue #876](https://github.com/vercel/eve/issues/876) records about 3.5 seconds from a warm
  channel webhook to model-step start, followed by only about 0.4 seconds of model work. Later
  reports observe 5–7 second dispatch/orchestration gaps.
- [Issue #1476](https://github.com/vercel/eve/issues/1476) reports 1.1–5.5 second new-session create
  latency. `createSession()` currently waits for the workflow to own its stable command hook
  before returning the already-known run id.

These sources measure different boundaries and must not be averaged together. The stress
fixture's `t.send()` resolves at the streamed `session.waiting` event, before the child step and
parent driver finish their whole tail. Back-to-back turns can therefore charge the previous
turn's tail to the next request. It is a valid user-visible response/throughput indicator, but not
an isolated measure of every phase.

### Local attribution

Three runs of the focused workflow-entry integration test on the local file-backed Workflow world
produced these warm medians:

| Phase                                     | Median |
| ----------------------------------------- | -----: |
| Root bind start → `session.waiting` write | 353 ms |
| `turnStep`                                |  50 ms |
| Time outside `turnStep`                   | 303 ms |
| Root caller-context bind step             |  44 ms |
| Child dispatch step                       |  48 ms |
| Child start → `turnStep` start            | 139 ms |
| Terminal control-send step                |  50 ms |
| Root caller-notification step             |  46 ms |

The run is repeatable with:

```sh
pnpm --filter eve build:js
pnpm --filter eve exec vitest run \
  --config vitest.integration.config.ts \
  src/execution/workflow-entry.integration.test.ts \
  -t "parks in conversation mode and resumes via runtime delivery" \
  --reporter=dot
```

The phase timestamps, persisted input/output sizes, and stream-chunk counts were read from
`packages/eve/.eve/.workflow-data/vitest-1/{runs,steps,streams}` after each of three clean runs.
This is directional attribution, not the success gate. Phase 1 promotes the extraction into a
committed reporter before an optimization relies on it.

The local world is not a hosted latency predictor, but the attribution is decisive: fixed durable
boundaries dominate even without network or model work. A two-turn run persisted 17 stream chunks.
The dispatch input also grew from 1,103 bytes to 1,579 bytes after one turn because the durable
session snapshot embeds full history.

A one-off codec spot check put devalue and compression CPU orders of magnitude below the measured
durable boundaries. It was not a committed benchmark and is not used as proof. The paired
benchmark should retain a reproducible codec/payload-size microcase; until then, transport,
storage, and replay of repeated snapshots remain in scope while codec micro-optimization does not.

## Current critical path

```text
client delivery
  └─ resume stable session hook
     └─ replay long-lived session driver
        ├─ bind caller step                 (no-op for root sessions)
        ├─ dispatch step
        │  └─ start a latest-deployment child turn workflow
        │     ├─ claim private inbox hook
        │     ├─ claim cancellation hook
        │     ├─ turnStep × model/tool cycles
        │     │  ├─ rebuild context, bundle, harness, and tools
        │     │  ├─ await each protocol stream write
        │     │  └─ await Workflow attributes update
        │     ├─ terminal control-send step
        │     └─ dispose private hooks
        ├─ resume and replay session driver
        ├─ adopt full returned state
        ├─ notify caller step               (no-op for root sessions)
        └─ rekey/park on the stable inbox
```

The child workflow exists for important reasons: a long-lived session driver stays pinned to its
originating deployment, while each child turn can run the latest deployment; the child also owns
turn cancellation and waits that span tool/subagent activity. An optimization cannot simply
delete it without replacing those semantics.

There are three independent performance dimensions:

```text
turn latency = fixed ingress/turn orchestration
             + model-step count × incremental durable-step overhead
             + history depth × replay/state-transfer growth
             + actual model, tool, hook, and provider work
```

A single 100-turn mean hides whether a change affects the fixed intercept, per-step slope, or
history slope. The benchmark must report all three.

## Measurement system

### Tracking added now

The Vercel stress fixture now records raw millisecond samples in a versioned JSON log record:

- sequential: every turn number and duration;
- concurrent: every session's first- and second-turn duration plus batch makespan;
- report: count, mean, p50, p90, p95, min, max, cold/warm buckets, and sequential
  turn-order slope, explicitly labeled as time-order confounded.

`scripts/workflow-stress-report.mjs` reads the normal eve eval artifacts and emits JSON and
Markdown. The existing PR Vercel e2e workflow appends the Markdown to the job summary and uploads
both reports plus raw eval artifacts on successful stress runs. This establishes a history and
makes a regression visible without pretending that one hosted sample is a reliable gate.

### Paired runtime benchmark

Add a dedicated `apps/runtime-benchmarks` driver and
`.github/workflows/runtime-performance.yml` rather than turning the correctness e2e suite into a
statistical harness. For a relevant same-repository PR, the workflow should:

1. build the merge base and head independently;
2. deploy both to immutable preview URLs in the same project and region;
3. warm both subjects, then alternate request order `base/head`, `head/base`;
4. retain every raw sample and both deployment/run identities;
5. publish a paired comparison in the job summary and a sticky PR comment using authenticated
   `gh`;
6. upload JSON and Markdown on every outcome.

The initial cases are:

| Case                                         | Purpose                                                         |
| -------------------------------------------- | --------------------------------------------------------------- |
| New session                                  | Split request acceptance, hook readiness, and first model start |
| Warm one-step turn                           | Measure the fixed turn intercept                                |
| 1, 2, 4, 8 deterministic tool cycles         | Fit incremental durable-step cost                               |
| Pre-seeded history depths 1, 10, 25, 50, 100 | Fit replay/state-growth slope                                   |
| 20–50 independent sessions                   | Measure p95, batch makespan, and turns/second under load        |

Use five unmeasured warmups, 20 paired samples for one-step cases, and at least 12 paired blocks for
step scaling. Never discard outliers. Report p50/p90/p95, median absolute deviation, paired delta
and ratio, a deterministic bootstrap 95% confidence interval, fixed-turn intercept,
incremental-step slope, and history-depth slope.

History-depth subjects must be independent pre-seeded sessions, requested in randomized or
balanced interleaved order. Advancing one session from turn 1 through 100 remains a useful
throughput test, but cannot separate history growth from elapsed test time.

The artifact schema must include the base/head SHAs, eve and Workflow package versions, world,
region, deployment URLs, run ids, request order, history depth, step count, event/stream-write
count, serialized input/output bytes, and raw client and server phase durations. Client monotonic
timings and server event timestamps stay separate; subtracting clocks from different machines
would manufacture precision.

Run an A/A trial and at least 30 successful main batches before enforcing hosted timing budgets.
During calibration, a possible warning floor is a paired regression above both 10–15% and
75–100 ms. The eventual gate should fail only when a confirmatory batch agrees and the 95%
confidence interval clears both the relative and absolute budgets. Absolute cold-start latency and
one noisy p95 sample must not block a PR.

A nightly main run should repeat the suite three times, retain raw GitHub artifacts, and publish
the aggregates to the existing observability backend for trend and SDK-release correlation.
Workflow Agent Runs traces are valuable for phase attribution and outliers, but should not be the
primary benchmark dependency; CI needs a project-scoped token to inspect those runs.

### Phase attribution

Add opt-in benchmark instrumentation for these boundaries:

- HTTP receipt → hook resume persisted/published;
- driver wake/replay → bind → child dispatch;
- child created → child started → hook ownership → first `turnStep`;
- each `turnStep`: scheduling gap, actual model/tool work, attributes write, protocol writes;
- `session.waiting` emitted → step completed → terminal control delivered;
- parent resumed → state adopted → caller settled → driver parked;
- event-log entry count/bytes and durable session/context bytes at each boundary.

The deterministic benchmark should disable external telemetry exporters. A separate diagnostic
pass can measure real OTLP/provider flush cost so instrumentation overhead is not hidden inside
framework overhead.

## Experiments

Experiments are ordered by information value and expected risk. Each change gets a paired hosted
run, the narrowest correctness tests, cancellation/replay tests where relevant, and the existing
stress e2e before it can ship.

### 1. Isolate Workflow SDK and resume cost

Run the same eve SHA against the current Workflow package set and beta.47, with beta.46 included
if its public hook API is compatible. Interleave at least five deployed runs per package set. Add
a small Workflow-only benchmark for one persisted `resumeHook` and an eve-shaped two-resume child
round trip.

This decides whether the recent approximately 1.8-second fixed regression belongs in eve, the
Workflow SDK/world, or their interaction. If write-before-wake is the cost, work with Workflow on
a transactional persist-and-wake primitive; eve must not restore a lossy wake ordering.

### 2. Remove guaranteed root no-op steps

Skip `bindTurnCallerContextStep`, `notifyTurnCallerStep`, and the initial caller-resolution step
when serialized lineage proves there is no delegated caller. Root sessions pay two no-op steps on
every settled turn today, about 90 ms combined even in the local world. Subagent, callback, task,
and crash-cleanup behavior remains on the existing path.

This is the lowest-risk structural change. Prove exact step-count reduction and no change to root,
subagent, task, failure, and cancellation results.

### 3. Overlap retired control cleanup with parent settlement

After turn N+1 publishes its terminal result, turn N's deferred control hook is safe to retire.
Start that cleanup immediately, overlap it with turn N+1's independent parent settlement
(continuation rekey, cancellation settlement, caller notification, or terminal finalization), and
join both before the driver publishes `session.waiting`, starts another turn, or returns. Preserve
the existing cleanup-first error precedence if both operations fail. This can hide one durable
hook-disposal boundary on warm turns without detaching work or changing hook ownership.

Do not apply the same overlap inside the active child turn. Its cancellation hook must be disposed
before terminal control is published: that control wakes the driver, which can immediately start a
successor that claims the next cancellation surface. Starting both writes concurrently would
reintroduce a claim/teardown race and could weaken cancellation. Workflow bodies also expose no
request `waitUntil` lifetime; all durable cleanup remains joined.

### 4. Remove observability-only writes from each step

`setEveAttributes` is awaited after every model attempt. Inside a Workflow step the SDK writes an
attribute event to the world, so best-effort error handling does not make it non-blocking. First
A/B the stress and 1/2/4/8-step cases with the write disabled. If material, aggregate token/model
attributes and persist them once at turn settlement, or attach them to an existing durable event.

Likewise measure the 8–9 individually awaited protocol stream writes in a simple turn. Keep text
and tool output streaming immediate, but prototype coalescing adjacent lifecycle-only events into
2–3 flushes. Event order and the final response boundary must remain identical.

### 5. Reduce child startup and control handshakes

Measure child-created → first-step-start in production before choosing a design. Then prototype,
in increasing order of risk:

1. combine or reuse the child inbox and cancellation/control hook with `(turnId, sequence)`
   deduplication;
2. move terminal control delivery into an existing step without publishing state before its
   durable checkpoint;
3. execute ordinary no-wait turns directly from the driver or a persistent executor, retaining
   the child path only when cancellation/runtime waits require it;
4. ask Workflow for a latest-deployment step/child-completion primitive that avoids a second run
   and polling join.

The third option is only viable if it retains latest-deployment routing. Running all future turns
inside the pinned driver would improve latency by silently disabling live upgrades, which is not
an acceptable trade.

### 6. Bound replay and state growth

Measure event-log entries/bytes and state payloads at every target history depth. Full history is
currently embedded in each session snapshot, passed into the child, returned by `turnStep`, sent
through terminal control, and retained in the long-lived driver's event log. The hosted
turn-order trend and growing local payloads make this a strong hypothesis, not a proven cause.

Prototype two approaches independently:

- append-only history with a revision/cursor and periodic bounded snapshots, so a turn transfers
  only its delta while a step can hydrate the current revision once;
- a successor-run chain, Workflow's documented `continueAsNew` analogue, where each bounded run
  handles one turn and hands state/inbox ownership to a latest-deployment successor.

The external-state option adds a read/write round trip and wins only if it costs less than repeated
snapshot transport/replay. The successor-run option is the most promising structural design
because it can replace both the replay-growing driver and per-turn child, but it needs an atomic
handoff protocol.

### 7. Move new-session readiness off the caller path

The workflow run id exists as soon as `start()` resolves, yet `createSession()` waits until the
workflow owns its command hook. Test two compatible improvements:

- claim the stable and authorization hooks before session hydration/caller resolution, allowing
  their commit to overlap `createSessionStep`;
- return an accepted session id immediately and define explicit `starting` behavior for send,
  cancel, reset, and stream attachment until hook ownership is ready.

The second option improves API acceptance latency but does not by itself start the model sooner.
The first can improve both. The benchmark reports acceptance, readiness, and first-model timing
separately so the result cannot be presented as a turn-speed improvement when it only moves the
wait.

### 8. Budget extension and per-step work

After the fixed topology is addressed, fit the incremental cost of tool cycles and authored
extensions. Time adapter delivery, memory lifecycle, stream hooks, dynamic model/connections/
subagents/tools/skills/instructions, tool-wrapper construction, and instrumentation flushes.
Expose slow-provider diagnostics and move network exporter flush from every model/tool step to a
safe turn-end or background boundary where possible.

Do not combine side-effectful tool cycles into one replayable step unless each tool invocation
keeps an independent durable idempotency checkpoint. Faster retries that repeat external effects
are a correctness regression.

## Structural direction

The preferred long-term prototype is a chain of bounded, latest-deployment turn runs behind a
stable eve session identity:

```text
stable session address
  └─ current owner run N
       ├─ accept exactly one sequenced delivery
       ├─ execute and stream the turn
       ├─ checkpoint state revision N
       ├─ start latest-deployment owner run N+1
       └─ atomically hand off the stable inbox, then exit
```

This would make replay bounded and remove the parent-driver/child-control round trip. It is an
experiment, not a settled implementation. The handoff must preserve all of these invariants:

- one active turn per session and FIFO delivery under concurrent sends;
- stable public session id and continuation aliases independent of Workflow run ids;
- no delivery loss or duplicate model/tool execution across crash/retry/handoff;
- latest-deployment routing and versioned state migration;
- ordered, resumable event streaming across successor runs;
- turn cancellation, session cancel/reset/timeout, authorization and input waits;
- subagent/task caller settlement and descendant routing;
- safe at-least-once terminal notifications and stale-message rejection.

If Workflow cannot provide atomic hook ownership transfer, an eve-owned sequenced inbox/CAS may be
necessary. A direct ingress fast path that starts a turn before driver replay is another possible
prototype, but it has the same serialization and fencing problem and should follow, not precede,
the successor-run experiment.

## Proof of success

An optimization is proven only by a paired base/head hosted benchmark with raw artifacts. Its
bootstrap 95% confidence interval must show an improvement, its p95 must not regress materially,
and all durable correctness suites must pass. For the first structural release, target:

- at least 30% and 750 ms lower warm one-step p50 on the deterministic hosted benchmark;
- no more than a 10% p95 regression in any benchmark case;
- at least 50% lower fixed-turn intercept in the step-scaling fit;
- last-ten versus first-ten warm (turns 2–11) latency growth below both 10% and 200 ms at depth
  100;
- no increase in exact durable step/hook/stream-write counts unless phase data proves a net win;
- unchanged event order, model/tool outputs, replay, cancellation, latest-deployment, and
  concurrent-delivery semantics.

The product north star is sub-second framework-controlled time from a warm accepted delivery to
model-step start at p50, with p95 below 1.5 seconds. Phase data may show a platform floor that eve
cannot remove alone; in that case the report must isolate that floor and the plan moves the
corresponding primitive into the Workflow workstream rather than weakening the measurement.

## Non-goals

- Counting a faster model/provider as an eve performance improvement.
- Masking pre-model delay with UI animation or synthetic streaming.
- Optimizing generic map construction, metadata parsing, or compression before phase data makes
  it material.
- Trading away durability, retry safety, event ordering, cancellation, or live-deployment routing.
- Adding legacy fallback paths for superseded performance architectures.
