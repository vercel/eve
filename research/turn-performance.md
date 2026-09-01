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
8–9 stream chunks, resumes the session driver twice, and carries the full session snapshot through
multiple persisted values. Workflow already group-commits adjacent stream chunks at the World
boundary, so chunk count is not equivalent to persistence-request count. Two of the explicit
steps perform no work for a root session. Every additional model/tool cycle schedules another
`turnStep` and performs another Workflow attributes write.

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

The same increment includes one conservative critical-path change. Best-effort Workflow
attributes now start in parallel with result settlement, allowing the user-visible terminal event
to persist first, but the durable step still joins the attribute write before it exits. This
preserves cumulative-write ordering and identical local and hosted lifetime behavior.

The independent hosted trials now identify one mergeable result and one architectural target.
Removing guaranteed root-only caller steps reduces sequential mean by 33.1% in isolation; the
current PR combination reduces mean by 34.0%, p50 by 33.9%, and p95 by 36.6%. A benchmark-only
inline-turn prototype reduces p50 by 63.5%, and its combination with the root optimization
reproduces 0.799–0.828-second p50s. That fast path cannot ship because it loses live-deployment,
cancellation, and runtime-wait semantics, but it proves that eve's parent/child topology—not the
hosted platform—is the largest remaining fixed cost.

The narrow background-work pass found no additional hot-path await that can safely move to
`ctx.waitUntil` today. Request-route work already uses Nitro's lifetime primitive; Workflow steps
have no supported equivalent. Stream writes are already group-committed, the stress fixture's
instrumentation flush is a no-op, and detaching attributes, hook operations, or terminal cleanup
would weaken persistence ordering, retry safety, or cancellation. The useful follow-up is a small
set of explicit Workflow primitives, not an eve fire-and-forget shim.

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
        │     │  ├─ enqueue each ordered protocol stream chunk
        │     │  └─ overlap attributes with result handling, then join
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

### Low-risk await audit

`ctx.waitUntil` is not one uniform primitive in this stack. Channel routes collect promises and
forward a failure-observing aggregate to Nitro's request `waitUntil`, so their response can return
first. Schedule handlers expose the same authoring name but await all registered work before the
task completes. Workflow bodies and steps expose no public `ctx.waitUntil`; Workflow's executor
uses a private host `waitUntil` only for its own tracked stream operations.

Detaching work from a Workflow step therefore moves it outside Workflow durability. The step can
complete and a successor can run first; a retry can duplicate or reorder the work; a crash,
timeout, or deployment can lose it; and its failure cannot retry the step. A rejected background
promise can also become an unhandled rejection unless it is converted to a fulfilled, logged
result. Only work that tolerates all of those outcomes is eligible.

The hot-path audit produced this disposition:

| Awaited work                                                                                         | Critical property                                                                            | Disposition                                                                                 |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Per-attempt `$eve.*` attribute write                                                                 | Best-effort metadata, but cumulative writes must stay ordered and precede terminal run state | Overlap with result handling now; keep the join inside the step                             |
| Instrumentation provider `flush()`                                                                   | Public idle-drain guarantee; authored providers may buffer state                             | Measure, then split exporter drain from authored idle drain before backgrounding anything   |
| Activity projection callback                                                                         | Best-effort presentation only; already invoked with `void`                                   | Retain lifetime and batch for reliability; there is no await left to remove                 |
| Stable and authorization hook claims                                                                 | Both are required before the session can serve work, but neither depends on the other        | Start together and await both; preserve partial-failure cleanup                             |
| Continuation ownership and stable-hook readiness                                                     | Both gate a create result, but can proceed independently after the Workflow starts           | Start together and await both; preserve ownership-conflict behavior                         |
| Protocol stream write/close                                                                          | Client event order and durable response boundary                                             | Keep awaited; Workflow already batches and background-flushes its tracked stream operations |
| Adapter delivery, memory, hooks, dynamic extensions, connections                                     | Return values, context mutation, authored failure semantics, or next-step input              | Keep awaited                                                                                |
| Hook resume/claim/dispose, caller notification, task acknowledgement, cancellation and child cleanup | Ownership, wake ordering, and terminal settlement                                            | Keep awaited                                                                                |
| Instrumentation event handlers and trace preparation                                                 | Provider ordering, durable context state, and trace parenting                                | Keep awaited                                                                                |
| Channel route background tasks                                                                       | Post-ack webhook work                                                                        | Already uses the appropriate request `waitUntil` path                                       |

The first code change starts `setEveAttributes()` and `handleStepResult()` together, including the
terminal `session.waiting` epilogue, then joins the attribute promise before returning from
`turnStep`. This can hide the attribute round trip behind work already required to settle the
result without allowing older cumulative counters to overwrite newer ones or racing
`run_completed`. A focused unit test proves the overlap and join ordering; it does not prove a
hosted latency win, which still requires the paired benchmark.

The next low-risk trials are:

1. measure attribute-write and instrumentation-flush duration and presence per step;
2. parallelize independent stable/authorization hook claims and, on operation-id creates,
   continuation-ownership/stable-hook readiness checks;
3. if the attribute write remains material, coalesce one final cumulative batch into the existing
   terminal control step and overlap it with the control resume;
4. split internal OTel export draining from authored provider idle flushing, then retain only the
   exporter drain in the host lifetime;
5. batch activity projections once per step and retain that callback for reliability.

A direct host `waitUntil` comparison belongs in a fault-injection experiment, not the low-risk
shipping queue. It must measure latency, `$eve.*` tag retention, crash loss, retries, and
cross-step ordering, and it must not ship until Workflow exposes a supported step-lifetime API.

Do not import Workflow's private `waitUntil` helper. Either use a supported public Workflow
step-lifetime API when one exists or keep the awaited join. A host-only fallback that silently
no-ops outside Vercel would make correctness environment-dependent.

## Experiments

Experiments are ordered by information value and expected risk. Each change gets a paired hosted
run, the narrowest correctness tests, cancellation/replay tests where relevant, and the existing
stress e2e before it can ship.

### Hosted experiment ledger

All deltas below use the exact benchmark-base run as the control. The stress model is synchronous,
so these measurements isolate eve and Workflow overhead rather than provider latency. Each row is
an independently pushed branch unless explicitly labeled as a combination. Raw JSON and Markdown
reports are attached to the linked GitHub Actions runs.

| Experiment                                     | Run                                                                     | Sequential mean | Sequential p50 | Sequential p95 | Concurrent second p50 | Turn-order slope | Decision                        |
| ---------------------------------------------- | ----------------------------------------------------------------------- | --------------: | -------------: | -------------: | --------------------: | ---------------: | ------------------------------- |
| Exact benchmark control                        | [`33468124247`](https://github.com/vercel/eve/actions/runs/33468124247) |         3.042 s |        3.036 s |        3.692 s |               1.867 s |   +13.31 ms/turn | Reference                       |
| Parallel readiness hooks                       | [`33468104562`](https://github.com/vercel/eve/actions/runs/33468104562) |         3.018 s |        2.897 s |        3.753 s |               1.867 s |   +13.80 ms/turn | Neutral on follow-up turns      |
| Workflow SDK beta.47                           | [`33468117677`](https://github.com/vercel/eve/actions/runs/33468117677) |         4.460 s |        4.847 s |        6.422 s |               1.863 s |    +7.40 ms/turn | Reject; material regression     |
| Remove root no-op steps                        | [`33468608676`](https://github.com/vercel/eve/actions/runs/33468608676) |         2.036 s |        2.053 s |        2.367 s |               1.584 s |    +5.17 ms/turn | Ship                            |
| Root no-ops + attribute overlap                | [`33469404605`](https://github.com/vercel/eve/actions/runs/33469404605) |         2.009 s |        2.008 s |        2.341 s |               1.607 s |    +5.27 ms/turn | Current PR candidate            |
| Inline ordinary root turn                      | [`33468225787`](https://github.com/vercel/eve/actions/runs/33468225787) |         1.170 s |        1.110 s |        1.515 s |               0.946 s |    +0.44 ms/turn | Ceiling only; semantics missing |
| Root no-ops + inline root turn, confirmation 1 | [`33469355029`](https://github.com/vercel/eve/actions/runs/33469355029) |         0.814 s |        0.799 s |        1.063 s |               0.743 s |    +2.63 ms/turn | Architectural floor             |
| Root no-ops + inline root turn, confirmation 2 | [`33469627035`](https://github.com/vercel/eve/actions/runs/33469627035) |         0.858 s |        0.828 s |        1.218 s |               0.738 s |    +3.35 ms/turn | Architectural floor reproduced  |

The current PR candidate improves the exact control by 34.0% on sequential mean, 33.9% on p50,
36.6% on p95, and 13.9% on concurrent second-turn p50. The independently confirmed root no-op
change accounts for almost all of that result; attribute overlap is directionally small compared
with hosted noise. The two combined-floor runs reproduce a 71.8–73.2% mean reduction and a
72.7–73.7% p50 reduction, proving that sub-second warm turns are possible if eve replaces the
parent/child topology without losing its semantics.

### 1. Isolate Workflow SDK and resume cost

Run the same eve SHA against the current Workflow package set and beta.47, with beta.46 included
if its public hook API is compatible. Interleave at least five deployed runs per package set. Add
a small Workflow-only benchmark for one persisted `resumeHook` and an eve-shaped two-resume child
round trip.

This decides whether the recent approximately 1.8-second fixed regression belongs in eve, the
Workflow SDK/world, or their interaction. If write-before-wake is the cost, work with Workflow on
a transactional persist-and-wake primitive; eve must not restore a lossy wake ordering.

#### Hosted result

The isolated `barba/perf-exp-workflow-sdk-latest` branch changed only the aligned Workflow
packages from the benchmark base to beta.47. Its stress job
[`33468117677`](https://github.com/vercel/eve/actions/runs/33468117677) completed and regressed
sequential mean from 3.042 to 4.460 seconds (+46.6%), p50 from 3.036 to 4.847 seconds (+59.7%),
and p95 from 3.692 to 6.422 seconds (+73.9%). Concurrent second-turn p50 was effectively neutral
at 1.863 versus 1.867 seconds, so the package set changed the sequential path rather than applying
a uniform hosted-load penalty.

Do not upgrade eve on this result. The two approximately 4.91-second runs from PR #2611 point in
the same direction, but the experiment does not assign causality to one Workflow change because
the compatible core, API, Vercel World, and Nitro packages moved together. A Workflow-only
`resumeHook`/child-round-trip microbenchmark is still required before attributing the regression
to write-before-wake or another persistence change.

### 2. Remove guaranteed root no-op steps

Skip `bindTurnCallerContextStep`, `notifyTurnCallerStep`, and the initial caller-resolution step
when serialized lineage proves there is no delegated caller. Root sessions pay two no-op steps on
every settled turn today, about 90 ms combined even in the local world. Subagent, callback, task,
and crash-cleanup behavior remains on the existing path.

This is the lowest-risk structural change. Prove exact step-count reduction and no change to root,
subagent, task, failure, and cancellation results.

#### Hosted result

Two Vercel stress runs of the isolated change reproduced a material improvement against a
contemporaneous instrumentation-only control. The first experiment SHA, `522e869`, is runtime
identical to the final `863daf1` SHA; the amend changed comments only. All three stress jobs
completed successfully and uploaded their raw JSON reports:

- [Control run `33468124247`](https://github.com/vercel/eve/actions/runs/33468124247), SHA
  `57b477d`, with [artifact `9785707208`](https://github.com/vercel/eve/actions/runs/33468124247/artifacts/9785707208).
- [Experiment run `33468070932`](https://github.com/vercel/eve/actions/runs/33468070932), SHA
  `522e869`, with [artifact `9785657364`](https://github.com/vercel/eve/actions/runs/33468070932/artifacts/9785657364).
- [Confirmatory experiment run `33468608676`](https://github.com/vercel/eve/actions/runs/33468608676),
  final SHA `863daf1`, with
  [artifact `9785832093`](https://github.com/vercel/eve/actions/runs/33468608676/artifacts/9785832093).

The control and confirmatory workflows' aggregate conclusions are failures because their separate
`fixture-tasks` jobs failed. Their `agent-workflow-stress` jobs and artifact uploads succeeded.

| Raw artifact metric         |        Control |           Experiment 1, delta |          Experiment 2, delta |
| --------------------------- | -------------: | ----------------------------: | ---------------------------: |
| Sequential mean             |        3.042 s |    2.184 s, −0.858 s (−28.2%) |   2.036 s, −1.006 s (−33.1%) |
| Sequential p50              |        3.036 s |    2.057 s, −0.979 s (−32.3%) |   2.053 s, −0.983 s (−32.4%) |
| Sequential p90              |        3.584 s |    2.455 s, −1.129 s (−31.5%) |   2.288 s, −1.295 s (−36.1%) |
| Sequential p95              |        3.692 s |    2.527 s, −1.165 s (−31.6%) |   2.367 s, −1.326 s (−35.9%) |
| First 10 warm mean          |        2.396 s |    1.806 s, −0.591 s (−24.6%) |   1.722 s, −0.674 s (−28.1%) |
| Last 10 mean                |        3.607 s |    2.362 s, −1.244 s (−34.5%) |   2.209 s, −1.398 s (−38.8%) |
| Sequential turn-order slope | +13.31 ms/turn | −0.08 ms/turn, −13.39 ms/turn | +5.17 ms/turn, −8.14 ms/turn |
| Concurrent first-turn p50   |        5.679 s |    4.320 s, −1.359 s (−23.9%) |   4.394 s, −1.285 s (−22.6%) |
| Concurrent second-turn p50  |        1.867 s |    1.510 s, −0.357 s (−19.1%) |   1.584 s, −0.283 s (−15.1%) |

Exact Workflow-world integration coverage confirms the mechanism: two root turns omit one caller
resolution, two caller binds, and two caller notifications, while the delegated two-turn path
retains that `1 + 2 + 2` step inventory and its results.

The result is replicated but not yet statistically paired. These workflows ran close together,
not as interleaved base/head blocks, and isolated maxima remained noisy: experiment 1 recorded a
15.687-second sequential maximum and a 3.025-second concurrent second-turn batch, while experiment
2 recorded a 6.373-second concurrent first-turn batch against the control's 6.282 seconds. The
p50 and p95 improved in both experiment runs, but the dedicated paired benchmark remains the proof
gate for shipping.

### 3. Reduce observability-only work in each step

`setEveAttributes` is awaited after every model attempt. Inside a Workflow step the SDK writes an
attribute event to the world, so best-effort error handling does not make it free. The first
low-risk change overlaps that write with result handling while still joining it before step exit.
A/B the stress and 1/2/4/8-step cases against the serialized implementation. If the remaining
cost is material, compare disabling the write, a host-retained write with measured tag retention,
and one cumulative write attached to the terminal control step.

The stream-write audit does not currently justify an eve runtime change. eve already coalesces
adjacent text, reasoning, tool-input, and tool-partial events in its bounded ordered emitter.
Workflow `@workflow/core@5.0.0-beta.43` then acknowledges `writer.write()` when a chunk enters its
bounded buffer and group-commits buffered chunks with `world.streams.writeMulti`. The Vercel World
implementation (`@workflow/world-vercel@5.0.0-beta.39`) preserves each chunk boundary inside that
single request. `writer.close()` drains pending writes before closing, and the step executor adopts
the same drain barrier when eve releases the writer lock to park.

A controlled probe against the installed Workflow stream implementation used eight ordered chunks
and a mocked World with 20–40 ms write latency:

| Write pattern                       | World data writes          | Close writes | Consequence                        |
| ----------------------------------- | -------------------------- | -----------: | ---------------------------------- |
| Immediate, default flush interval   | 1 `write` + 1 `writeMulti` |            1 | No leading delay                   |
| 30 ms apart, default flush interval | 8 `write`                  |            1 | No adjacent chunks to group-commit |
| Immediate, 5 ms flush interval      | 1 `writeMulti`             |            1 | At least 5 ms leading delay        |

This is protocol-level evidence, not a hosted latency result. It disproves the assumption that
eight awaited eve writes necessarily create eight persistence round trips. Making the global
flush interval positive could collapse a burst to one request, but would add fixed delay to the
first text, tool, and terminal chunk of every idle stream. That violates this experiment's
immediate-streaming constraint.

Packing several eve events into one Workflow chunk is also incorrect with the current protocol.
Workflow reconnects by chunk index, while eve clients increment that cursor once per decoded
event. A disconnect after the first event in a packed chunk would resume at the next chunk and
skip the remainder. Promise concurrency would not reduce backend writes and could move lifecycle
handlers ahead of durable event order.

The narrow useful upstream primitive is a `writeMany(chunks)` or scoped `cork()`/`uncork()` that
invokes `writeMulti` while retaining distinct chunk indexes. Before requesting it, hosted traces
should count `workflow.stream.flush` operations, chunks per flush, buffer dwell, and chunk RTT to
show that lifecycle bursts actually miss the existing in-flight group commit. The current
ordering-barrier, sink-failure/drain, reconnect, rewind, and terminal-`session.waiting` tests are
the correctness baseline for any later prototype.

#### Narrow coalescing result: blocked on a Workflow primitive

A prototype on benchmark base `57b477dc1` carried cumulative metrics out of each successful
`turnStep`, retained only the latest totals, and wrote them before `resumeHook` in the existing
terminal control step. The happy path can collapse repeated writes, but the current Workflow APIs
do not preserve the required failure and retry semantics:

- Step-body `setAttributes` appends an unguarded, out-of-band `attr_set`. If terminal hook delivery
  fails after that write and the step retries, it appends another event. Last-write-wins keeps the
  displayed counters correct, but the promised one-write invariant and its performance cost do
  not survive retries.
- The newest metrics exist after the model returns but before harness post-processing finishes.
  Deferring them until a successful `StepResult` loses that attempt's counters when a stream,
  hook, memory, or dynamic-extension callback fails in the same step. The current write happens
  before this failure boundary.
- Workflow-body `setAttributes` is replay-correlated, but it commits through a suspension and an
  additional replay. It is neither background work nor part of the terminal control step, and
  makes observability progress part of workflow progress.

Do not ship this coalescing change on the current SDK. The useful upstream shape is either an
idempotent attribute update keyed by a stable operation id, or a terminal primitive that commits
attributes and hook delivery atomically. Workflow exposes no step- or run-scoped `waitUntil`
today. Such a primitive would help only if Workflow durably joins it before teardown, isolates
best-effort failures from the run, and deduplicates its side effect across step retries;
fire-and-forget alone is insufficient.

### 4. Reduce child startup and control handshakes

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

The narrow inbox/cancellation-hook pass found no semantics-preserving lazy claim. The inbox claim
is the duplicate child-run fence: deferring it until a runtime-action wait would let duplicate
starts execute the model, tools, and side effects concurrently. The cancellation claim must be
ready before the first `turnStep`, because an otherwise ordinary one-step turn can be steered or
cancelled while its model or tool is running.

One hook can demultiplex tagged cancel and runtime-action payloads within a single deployment, but
it cannot replace the two current tokens safely across deployment versions. Session drivers stay
pinned while child turns route to latest: old drivers resume `{control}:cancel`, and the shared
duplicate-run fence must remain `{control}:inbox` so old and new child retries still contend for
the same owner. A per-turn readiness handshake adds another durable control step, while
`HookOptions.metadata` makes every inbox resume hydrate the run encryption key; the current
Workflow SDK explicitly takes that slower path for any metadata-bearing hook. Either choice can
cost more than the claim it removes, especially on subagent/runtime-action turns.

The required Workflow primitive is one hook entity with atomically registered token aliases (or
an equivalent public, no-key-lookup protocol capability). Aliasing both `{control}:inbox` and
`{control}:cancel` to one durable iterator would preserve old-driver cancellation, cross-version
duplicate fencing, stale-message isolation, and one-claim startup. Until that exists, keep the two
hooks; there is no safe hosted A/B whose faster result would represent shippable behavior. The
research-only branch `barba/perf-exp-turn-hook-coalesce` records the rejected prototype at
`3343fc7`; no runtime changes remain on that branch.

The third option is only viable if it retains latest-deployment routing. Running all future turns
inside the pinned driver would improve latency by silently disabling live upgrades, which is not
an acceptable trade.

#### Child return-value result: failed under sustained turns

Branch `barba/perf-exp-child-return` replaced the terminal `resumeHook` with a negotiated child
workflow return value. New drivers started a durable step that awaited `Run.returnValue` while
continuing to service nonterminal control messages; older pinned turn workflows retained the
existing terminal-control protocol. The design preserved latest-deployment child dispatch and
the turn workflow's cancellation/runtime-wait ownership, so it isolated the completion channel
rather than deleting the child boundary.

The focused two-turn integration path passed, but the installed
`@workflow/core@5.0.0-beta.43` implements `Run.returnValue` by polling run state every second from
a `"use step"` getter and warns that the wait occupies a queue worker. The hosted stress run
[`33469001202`](https://github.com/vercel/eve/actions/runs/33469001202) then failed the sequential
case after only two completed turns: turns 1 and 2 took 2.536 and 2.379 seconds, turn 3 never
settled, and the eval aborted at 600.002 seconds. The concurrent two-turn case completed in 9.651
seconds, but no performance report was emitted because the sequential gate timed out. The raw
JUnit evidence is retained in
[artifact `9786105820`](https://github.com/vercel/eve/actions/runs/33469001202/artifacts/9786105820).

Do not ship the polling join. The sustained-turn stall is consistent with the SDK's documented
worker-capacity hazard, and replacing one terminal resume with a polling step is not a latency
optimization even before that failure. A viable upstream primitive must let a workflow subscribe
to child completion without polling or reserving a worker, replay the terminal value/error
deterministically, and race safely with hook messages. The beta.47 SDK adds a long-poll path in
worlds that support it, but its isolated full-package A/B regressed this fixture materially, so
that package update is not evidence that this design is safe or faster.

### 5. Bound replay and state growth

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

### 6. Move new-session readiness off the caller path

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

#### Parallel readiness result

The isolated `barba/perf-exp-parallel-hooks` branch started independent stable/authorization
claims together and overlapped continuation-ownership validation with stable-hook readiness while
retaining partial-failure cleanup. Focused correctness, type, invariant, and build checks passed.
Its hosted stress run
[`33468104562`](https://github.com/vercel/eve/actions/runs/33468104562) was neutral on the measured
follow-up path: mean changed from 3.042 to 3.018 seconds (−0.8%), p50 to 2.897 seconds (−4.6%),
p95 to 3.753 seconds (+1.6%), and concurrent second-turn p50 remained 1.867 seconds. The first
cold turn was also unchanged at 2.614 versus 2.615 seconds.

This does not justify a turn-performance claim. The changed awaits primarily affect session
creation/readiness, while the current stress fixture measures follow-up turns after setup. Keep
the branch as a candidate for the dedicated acceptance/readiness benchmark, not as part of the
turn-latency shipping change.

### 7. Budget extension and per-step work

After the fixed topology is addressed, fit the incremental cost of tool cycles and authored
extensions. Time adapter delivery, memory lifecycle, stream hooks, dynamic model/connections/
subagents/tools/skills/instructions, tool-wrapper construction, and instrumentation flushes.
Expose slow-provider diagnostics. Separate internal network exporter drain from the authored
provider `flush()` contract, move only the exporter drain to a host-retained boundary, and keep
authored flush awaited at actual park/done/error transitions.

Do not combine side-effectful tool cycles into one replayable step unless each tool invocation
keeps an independent durable idempotency checkpoint. Faster retries that repeat external effects
are a correctness regression.

#### Instrumentation flush audit

The low-risk audit found a real critical-path await, but no safe detach primitive available to
eve step code today. `createExecutionNodeStep()` awaits `instrumentation.flush()` in `finally`
before `turnStep` can derive its next action. The resulting boundaries are:

| Path                                                                   | Awaited drains | Logical boundary                                  |
| ---------------------------------------------------------------------- | -------------: | ------------------------------------------------- |
| Ordinary harness result, including `action: "continue"`                |              1 | Model/tool step; session may continue immediately |
| Harness result that becomes `park`, `done`, or runtime-action dispatch |              1 | Idle, terminal, or durable dispatch boundary      |
| Adapter consumes a delivery without entering the harness               |              1 | Idle boundary                                     |
| Adapter failure before the harness                                     |              1 | Error boundary                                    |
| Harness failure                                                        |              2 | Harness `finally`, then delivery-failure cleanup  |
| Cancellation thrown by the harness                                     |              2 | Harness `finally`, then cancellation epilogue     |

For the provider-directory layout, each drain starts the OpenTelemetry runtime flush and every
authored provider `flush()` concurrently, awaits all of them, logs individual failures, and never
fails the user step. Awaiting the call also prevents flushes from successive iterations of one
session from overlapping. Detaching the entire operation would therefore change
authored-provider ordering as well as exporter timing.

This path does not explain the existing Vercel stress baseline. That fixture uses the legacy
single-file `instrumentation.ts` layout. Its eve runtime installs an async no-op `forceFlush`;
the optional Datadog `registerOTel()` call made during setup is outside that runtime. The current
per-step await in the stress fixture therefore drains no network exporter. A regression probe now
holds a fake drain open and proves structurally that a harness step cannot settle until the drain
does, without using timing-sensitive assertions.

There is no public, cross-world lifetime primitive that a transformed Workflow step can use to
move the real provider-directory exporter drain off its response path. Nitro's public
`event.waitUntil()` exists only at the route boundary, while the step body receives no `H3Event`.
Workflow's public exports expose no step-scoped equivalent. Its runtime has a private helper that
loads Vercel Functions' request-scoped `waitUntil`, but importing that private module would couple
eve to an unsupported implementation detail. Calling Vercel Functions directly is insufficient
for eve's portable runtime: outside a Vercel request context it silently registers nothing and
does not report whether the promise gained a lifetime owner, so an await fallback cannot be
selected reliably.

The required primitive is a public step-scoped operation such as
`waitUntil(promise): "registered" | "unsupported"` that guarantees the current invocation remains
alive in hosted, local, and self-hosted worlds, or explicitly reports that eve must await. Once it
exists, the narrow experiment should keep authored provider flushes awaited, serialize internal
exporter drains, register only the non-rejecting internal exporter promise in the step lifetime,
and retain full awaited drains for shutdown. A dedicated provider-directory fixture with a gated
exporter must prove both that step settlement no longer includes exporter latency and that the
export completes before invocation teardown. The existing stress fixture should show no expected
delta from this experiment; it needs a separate exporter diagnostic rather than being presented as
proof of the change.

### Inline-turn ceiling result

The benchmark-only branch in
[PR #2824](https://github.com/vercel/eve/pull/2824) executed an ordinary root turn in the session
driver instead of starting a child run. The isolated hosted run
[`33468225787`](https://github.com/vercel/eve/actions/runs/33468225787) reduced sequential mean by
61.6% (3.042 to 1.170 seconds), p50 by 63.5% (3.036 to 1.110 seconds), p95 by 59.0% (3.692 to
1.515 seconds), and concurrent second-turn p50 by 49.3% (1.867 to 0.946 seconds). The turn-order
slope fell from 13.31 to 0.44 ms/turn.

Combining that prototype with root no-op removal crossed the product target twice. Runs
[`33469355029`](https://github.com/vercel/eve/actions/runs/33469355029) and
[`33469627035`](https://github.com/vercel/eve/actions/runs/33469627035) recorded sequential p50s
of 0.799 and 0.828 seconds and p95s of 1.063 and 1.218 seconds. Both stress jobs passed. This is
the strongest evidence in the investigation: the existing platform can sustain sub-second warm
turns when eve removes the parent/child round trip.

The prototype is deliberately non-mergeable. It pins future ordinary turns to the driver's
deployment and lacks the child's mid-turn cancellation, runtime wait, sleep, and background-work
ownership. Those are product semantics, not optional overhead. The measurements establish an
architectural ceiling and justify a successor/latest-deployment primitive; they do not justify
shipping the inline fast path.

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

### Successor-run feasibility result

The executable prototype on `barba/perf-exp-successor-turns` narrows the design space, but it is
not a production candidate. The Workflow APIs provide two required pieces today:

- explicit recursive `start(..., { deploymentId: "latest" })` creates a bounded successor on the
  current deployment; and
- a `WritableStream` can be passed across runs, so successor output can remain on the original
  session stream.

They do not provide atomic ownership transfer for the stable command hook. Hook tokens have one
active owner. Disposing the old hook and claiming it in a successor are separate durable writes.
The integration proof deliberately gates the successor between those writes and observes
`HookNotFoundError` from both `getHookByToken()` and `resumeHook()`. A direct run-to-run handoff
would therefore reject a command in that interval and cannot replace the current driver.

The same test contains the narrowest lossless workaround supported by the current API:

```text
stable public token
  └─ minimal FIFO sequencer run
       ├─ active executor N receives commands
       ├─ executor N asks the sequencer to seal generation N
       ├─ sequencer forwards a seal, then durably holds later commands
       ├─ executor N drains every pre-seal command
       ├─ executor N starts latest-deployment executor N+1 with state + shared stream
       └─ sequencer activates N+1 and forwards held commands in FIFO order
```

Six burst deliveries produced six ordered stream records through six owning executor runs. Every
nonterminal executor persisted exactly five steps regardless of history depth; the terminal
executor persisted three. The deterministic executor token also fenced a losing duplicate start.
This proves that one-turn executor histories and stream continuity are possible with current
Workflow primitives.

It also shows why the workaround should not ship as the performance fix:

- the sequencer is still a long-lived relay whose hook/event log grows with every command;
- every ingress crosses a sequencer replay plus a forwarding step before the executor wakes;
- seal, successor start, readiness, and activation add five durable steps per nonterminal turn;
- the full conversation snapshot still grows once per successor input even though it is no longer
  copied repeatedly into one driver's event log; and
- the prototype intentionally omits production cancellation, timeout, authorization, HITL,
  subagent/task, terminal-caller, and failure-recovery paths.

Consequently there is no hosted stress result for this branch: wiring the prototype into the eve
runtime would knowingly add overhead and leave required semantics incomplete. The focused test is
the proof artifact, not a benchmark substitute. Commit `a4c7ae2` retains that artifact; two
focused integration cases, full typecheck, lint, and invariant checks pass.

The enabling Workflow primitive is an atomic, replay-idempotent successor handoff. Given a stable
token, expected owner/generation, handoff id, latest-deployment workflow reference, checkpoint,
and existing stream, one commit must:

1. fence the old owner at an exact inbox sequence;
2. start and register the successor on the latest deployment;
3. preserve or transfer every payload before the fence and route every later payload to the
   successor;
4. keep `resumeHook(stableToken, payload)` continuously addressable, never transiently not found;
5. return the same successor on replay of the handoff id; and
6. preserve the stable eve session id and original resumable stream.

An eve-owned durable inbox with monotonic sequence numbers and compare-and-swap ownership could
provide equivalent semantics, but then eve owns a new storage protocol, retry/fencing rules, and a
stream directory. Prototype that only if Workflow cannot expose the atomic operation. Even with
either handoff, append-only history revisions or delta snapshots remain a separate requirement to
remove the growing successor-input payload.

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
