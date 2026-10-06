---
issue: "Unassigned — tracking issue needed before implementation"
status: proposed
last_updated: "2026-10-05"
---

# Model benchmark tracking

## Decision and scope

Track correctness, latency, and cost of fixture evals over time, across
models and eve versions. The goal is to answer questions such as:

- Did eval X get a step change in latency across all models starting in eve
  version Y?
- Is model A 20% faster than model B on eval X at roughly the same cost?

Runs on trusted `main` revisions publish immutable, versioned records to
private Vercel Blob. An internal Vercel repository ingests those records into
Postgres and serves a dashboard. This repository owns execution and the record
contract. The internal repository owns the database schema, ingestion, and UI.

This is internal tooling, not a public eve API. It adds no required checks,
changes no PR workflow, and ships nothing in the published `eve` package.

Out of scope: harness comparisons (eve-bench owns those), coding-agent
authoring benchmarks (`apps/benchmarks` owns those), and per-PR regression
gating.

## Prior art

- **`vercel/agents` (omniagent)**: separate lanes, `evals/pr/*` and
  `evals/benchmark/*`, each with its own config. The benchmark lane runs on a
  12-hour cron and on dispatch, emits `results.jsonl`/`summary.json`/
  `metrics.json`, and keeps them only as 7-day artifacts. Reporting runs from
  trusted code, never from the evaluated revision.
- **`vercel/internal-agents` (e0)**: an eve `EvalReporter` measures cost,
  tokens, wall/active time, steps, and compactions per attempt. It keys
  comparability on model, reasoning, eve version, and task digest, and keeps
  an append-only baseline history compared against the trailing median.
- **`vercel-labs/eve-bench`**: publishes only from `push`, `schedule`, and
  `workflow_dispatch` events into a Blob result store (see
  `eve-code-benchmark.yml`). It pins model aliases to their AI Gateway catalog
  release, and it treats infrastructure failures as gaps rather than zeros.
- **Instruction latency experiments** (`prha/eval-latency`,
  `research/eval-latency-experiments.md`): derive measurements from captured
  eval event streams after execution. A measurement is either measured, with
  event evidence, or unavailable, with a reason.

This plan adopts e0's measurement set, the latency experiments' measurement
shape and event-derived primitives, and eve-bench's Blob publication,
model-version, and gap rules. It defers omniagent's separate benchmark lane to
phase 2.

GitHub Actions artifacts are not the durable store. `e2e-local` uploads
`.eve/evals` only on failure with 7-day retention, and GitHub caps retention
at 90 days. Scraping GitHub would also add polling, token management, and
rate limits to the ingest path.

## Architecture

```text
eve repo                                         internal repo
─────────────────────────────────────────────    ─────────────────────────────
plan ─► run (fixture × model × attempt) ─► publish ─► Blob ─► ingest ─► Postgres ─► dashboard
        AI_GATEWAY_API_KEY only            trusted main     cron     (rebuildable)
                                           Blob token only
```

- **Blob is the system of record.** Each run writes raw `.eve/evals` trees plus
  a `records.jsonl` that conforms to a versioned schema. Blob objects are
  immutable and keyed by `github_run_id`/`run_attempt`.
- **Postgres is a projection.** Ingest is idempotent and can rebuild the
  database from Blob. New metrics can be backfilled by re-deriving them from
  raw artifacts.
- **The record schema is the only cross-repo contract.** Every record carries
  `schema_version`. The internal repo can change its tables and UI without
  touching eve.

## Phases

**Phase 1 — existing evals.** Run the current fixture evals that already work
under live models, on every registry model, with repeated attempts. Even when
correctness is saturated, latency and cost are informative. Also publish the
mock-model world suites (see below). This answers both motivating questions
without authoring new evals.

**Phase 2 — benchmark lane.** Add evals that discriminate between models on
correctness. A fixture opts in with `evals/benchmark/`. Every eval there
carries the `benchmark` tag, the CI lane runs `--exclude-tag benchmark`, and
`pnpm guard:invariants` enforces the tag/directory pairing. Benchmark evals
reuse the fixture's agent and `evals.config.ts`.

## Model registry

`e2e/benchmark.json` is separate from `e2e/matrix.json`, so adding a
benchmark model never adds a CI check:

```json
{
  "models": [
    { "name": "openai-sol", "id": "openai/gpt-6-sol" },
    { "name": "anthropic-opus", "id": "anthropic/claude-opus-5.5" },
    { "name": "anthropic-sonnet", "id": "anthropic/claude-sonnet-5.5" },
    { "name": "google-flash", "id": "google/gemini-3.8-flash" },
    { "name": "kimi", "id": "moonshotai/kimi-k3" }
  ],
  "fixtures": ["agent-tools", "agent-subagents", "agent-tasks"],
  "attempts": 3,
  "judge": "openai/gpt-5.6-luna"
}
```

Fixtures already resolve any gateway id through `EVE_E2E_MODEL`. Before any
attempt runs, the workflow resolves each id against the AI Gateway catalog and
records its release date. If an id is missing from the catalog, the run fails
before it starts. The judge model is fixed per registry revision, because
score trends are meaningless when the judge changes underneath them.

## Workflow

`eval-benchmark.yml` never runs on `pull_request`. It has three triggers:

- **Nightly `schedule`** against `main` HEAD. It skips if HEAD matches the last
  successfully published run's SHA.
- **Release.** It runs after `release.yml` publishes a new `eve` version, so
  every release has at least one data point.
- **`workflow_dispatch`**, with optional `models`, `fixtures`, and `attempts`
  inputs to narrow cost.

Jobs:

- **plan**: fails unless `github.ref == refs/heads/main`. Emits the
  fixture × model × attempt matrix from `e2e/benchmark.json`.
- **run**: `continue-on-error`. It holds `AI_GATEWAY_API_KEY` only and uploads
  `.eve/evals` as a short-lived handoff artifact.
- **publish**: checks out trusted `main`. It validates artifacts, derives
  `records.jsonl` from them, and writes everything to Blob. This is the only
  job that holds the Blob token.

Cost is bounded by fixtures × models × attempts. At three attempts nightly,
budget is the main tuning knob. Dispatch can narrow any dimension.

## Metrics

The publish job derives all metrics from raw eval artifacts, not from a
reporter inside the evaluated revision. Every eval session captures its full
event stream, and every event carries a durable `meta.at` timestamp. Per-step
usage, `finishReason`, and the gateway `generationId` arrive on
`step.completed`. The standard set needs no runtime changes, and new metrics
can be backfilled from Blob.

### Measurement shape

Each metric value uses the measurement shape from the instruction latency
experiments (`research/eval-latency-experiments.md`):

```ts
type Measurement =
  | { status: "measured"; value: number; evidence?: { sessionId: string; eventId: string }[] }
  | { status: "unavailable" | "not-applicable"; reason: string };
```

A metric is `unavailable` when its evidence is partial or ambiguous, such as a
step without cost or a turn without a terminal event. It is never zero.
Medians exclude unavailable values. Coverage (measured / attempts) is reported
next to every aggregate.

### Standard set

Every attempt gets the standard set, versioned as `metrics_version`:

| Dimension   | Metric              | Derivation                                                                                 |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------ |
| Correctness | verdict, assertions | eval verdict; per-assertion name, severity, score, passed; judge scores                    |
| Latency     | eval wall ms        | eval `startedAt` → `completedAt`                                                           |
|             | turn ms             | `turn.started` → `turn.completed`/`failed`/`cancelled`, summed and per turn                |
|             | time to first token | `step.started` → first `message.appended`/`reasoning.appended` of the step                 |
|             | output tokens/s     | step `outputTokens` ÷ (`step.completed` − first delta)                                     |
| Attribution | model ms            | Σ `step.started` → `step.completed`                                                        |
|             | tool ms             | Σ `actions.requested` → `action.result`, matched by call id                                |
|             | task ms             | Σ `task.started` → `task.settled`                                                          |
|             | human wait ms       | `input.requested`/`approval.*`/`authorization.required` → resolution                       |
|             | compaction ms       | `compaction.requested` → `compaction.completed`                                            |
|             | framework ms        | turn time outside the union of model, tool, task, compaction, and human-wait intervals     |
| Cost        | cost USD            | Σ `step.completed.usage.costUsd`, split into primary and subagent sessions                 |
|             | tokens              | input, output, cache-read, cache-write; cache hit ratio = cache-read ÷ input               |
|             | peak context        | max step `inputTokens`                                                                     |
| Efficiency  | counts              | turns per session, steps per turn, tool calls per step, subagent fan-out and depth         |
|             | compactions, clears | `compaction.completed`, `context.cleared`                                                  |
| Reliability | failures            | `step.failed`, `turn.failed`, `session.failed` counts by `code`; tool error rate           |
|             | truncations         | steps with `finishReason: "length"`                                                        |
|             | outcome             | timed out, skipped, parked on input, `gap`                                                 |
| Context     | identity            | sha, eve version, workflow world, runner OS, started at, model release, eval digest, judge |

Framework ms is the attribution metric for eve-version step changes. It
counts the time inside turns when no model call, tool, task, compaction, or
human wait is in flight: turn startup, gaps between steps, and turn
finalization. Human wait is excluded from every latency aggregate so
approval-heavy evals stay comparable.

Known limits:

- `meta.at` is stamped at durable write. Model ms therefore includes eve's
  streaming writes during a step.
- Coalesced deltas can make time to first token slightly late.
- Judge-model cost is not in the agent's event stream and is not part of
  cost USD.

### Fixture bundles

A fixture can add a versioned bundle of eval-specific metrics that reuses the
same primitives and measurement shape. One example is the self-modification
bundle's parent-turn-to-final-child-completion. Bundles live next to the
fixture, and their values are namespaced as `<bundle>.<metric>`.

### Gaps

An attempt is a **gap**, not a failure, when it errors before any model step
completes or fails for an infrastructure reason. Gaps count toward coverage
but are excluded from pass rates and from latency and cost medians.

## Mock-model framework track

The world suites (`e2e-vercel`, `e2e-postgres`) already run every fixture with
deterministic mock models. With no model latency or cost, their timings come
close to pure eve overhead per workflow world. The nightly run includes one
mock-model leg per world. Records are marked `model_id: "mock"` and carry the
same schema. This is the lowest-noise signal for eve-version step changes,
at near-zero cost.

## Comparability

The comparability identity is
`(eval_id, eval_digest, model_id, model_release, judge_model, world)`.
Trend lines break wherever the identity changes, and runs with different
identities are never aggregated together. `eve_version` and `sha` are the
x-axis, not part of the identity. The dashboard maps SHAs to release tags so
results can be grouped by eve version.

Live-model latency is noisy. Comparisons use p50/p90 across at least three
attempts, and `started_at` is retained so provider-side drift (time of day,
incidents) can be inspected rather than attributed to eve.

## Internal repo (consumer)

These details are owned outside this repository and are listed only to pin
down the contract:

- **Ingest**: a Vercel cron lists new Blob prefixes, validates
  `schema_version`, and upserts rows keyed by
  `(github_run_id, run_attempt, fixture, eval_id, model_id, world, attempt)`.
- **Storage**: Postgres via Vercel Marketplace. Raw artifacts contain
  transcripts, so they stay in private Blob and are linked by URL.
- **Dashboard**: Next.js behind Vercel Authentication, reading through a
  read-only role. Views:
  - Trends: pass rate, p50 cost, p50 wall and framework latency per model over
    eve versions, with identity breaks marked.
  - Frontier: scatter of latency against cost, or pass rate against cost.
  - Eval detail: attempts with links to the GitHub run and Blob artifacts.

## Alternatives considered

- **Scrape GitHub artifacts.** Rejected because of retention limits, polling,
  and rate limits. Pushing to Blob is simpler and durable.
- **Write Postgres directly from CI.** Rejected because it couples the
  database schema to eve and loses raw data needed for backfills.
- **Braintrust / Datadog Experiments.** Their reporters already exist and
  are worth a trial on a nightly run. They are weaker at per-model,
  per-eve-version trend lines and cost/latency frontiers, which are the
  primary views here.
- **Run on every push to `main`.** Rejected as the default because of cost.
  Nightly runs and per-release runs give version resolution at bounded spend.

## Open questions

- Which fixtures seed phase 1, and which `real-model` evals later move into
  the benchmark lane?
- Budget: nightly with 3 attempts, or weekly with 5?
- Should e0's per-attempt record shape be adopted as `schema_version: 1` to
  share tooling?
- Can the AI Gateway generation lookup (by `generationId`) provide
  provider-side latency to split network and provider time out of model ms?
- Should the eval runner record client send and receive times, to measure
  cold start and stream delivery lag?
- Should the dashboard later include `apps/benchmarks` authoring results?
