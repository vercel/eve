---
issue: "Unassigned — tracking issue needed before implementation"
status: in-progress
last_updated: "2026-10-05"
---

# Model benchmark tracking: implementation plan

This plan implements the eve-repo side of
[`model-benchmark-tracking.md`](./model-benchmark-tracking.md). That side
covers execution, metric derivation, the record contract, and publication to
Blob. The internal ingest/dashboard repository is out of scope here, except
for the contract it consumes.

## Gaps found against the current code

These need resolving (or the design doc amending) before or during
implementation:

1. **Per-eval timing is not persisted.** `EveEvalResult` has `startedAt` and
   `completedAt`. `writeArtifacts` (`packages/eve/src/evals/runner/artifacts.ts`)
   drops both from `summary.json`, `results.jsonl`, and the per-eval detail
   file. "Eval wall ms" needs them. This is the only change to the published
   `eve` package (patch changeset).
2. **The measurement primitives are unmerged.** `captureSessions`,
   `completedTurns`, `totalModelCost`, and the `Measurement` shape live on
   `prha/eval-latency` under `scripts/eval-experiments/measurements/`.
   Decision: M1 moves them to `scripts/eval-metrics/` on `main` now, and
   `prha/eval-latency` rebases onto that.
3. **Some event names in the doc don't match the protocol.**
   `protocol/message.ts` defines:
   - human wait: `input.requested` → `input.resolved`,
     `approval.candidate` → `approval.settled`, and
     `authorization.required` → `authorization.completed` (there is no
     `approval.*` family beyond these)
   - tool time: `actions.requested` → `action.result`, matched by `callId`
   - task time: `task.started` → `task.settled`
4. **Subagent cost split.** `step.completed` events exist only for captured
   sessions. Remote and unattached delegated sessions report cost only
   through the primary session's rolled-up `usage` on
   `session.waiting`/`turn.waiting`/`session.completed`. Define it as:
   - primary cost = Σ primary-session `step.completed.usage.costUsd`
   - total cost = latest rolled-up `usage.costUsd`
   - subagent cost = total − primary

   If either side is missing, the value is `unavailable`.

5. **There is no attempts primitive.** `eve eval` has no repeat flag.
   Attempts become a matrix dimension: each attempt is its own job and its
   own `.eve/evals/<timestamp>/` tree. That also spreads attempts across
   runners and time.
6. **`eval_digest` is undefined.** Proposed definition: sha256 over the git
   tree/blob ids of the eval file, its fixture's `evals/evals.config.ts`,
   `agent/`, and `package.json`, plus `e2e/fixtures/e2e-config`. All are
   read with `git rev-parse HEAD:<path>`, so the digest is cheap,
   deterministic, and independent of the eve version.
7. **The Vercel mock world needs Vercel credentials.** Deploying to the
   Vercel world needs `VERCEL_TOKEN` in a run job, which conflicts with
   "run job holds `AI_GATEWAY_API_KEY` only", and preview timings include
   deploy-network effects. Phase 1 mock legs therefore cover the `local` and
   `postgres` worlds. A Vercel mock leg can follow, as its own job with only
   Vercel credentials.
8. **Release trigger.** Across workflows, `workflow_run` cannot see whether
   `changesets/action` actually published. Instead, add a final step to
   `release.yml`, gated on `steps.changesets.outputs.published == 'true'`,
   that runs `gh workflow run eval-benchmark.yml --ref main`. This works
   with `GITHUB_TOKEN`, which may trigger `workflow_dispatch`, and needs
   `actions: write`.

## Layout

```text
e2e/benchmark.json                         model registry (separate from matrix.json)
scripts/eval-metrics/                      shared, dependency-free, node --test
  measurements/{events,lifecycle,metrics}.mjs   moved from eval-experiments
  standard.mjs                             standard metric set (metrics_version)
  gaps.mjs                                 gap / outcome classification
  bundles/self-modification.mjs            first fixture bundle
scripts/eval-benchmark/
  plan.mjs                                 registry + catalog → matrix
  catalog.mjs                              AI Gateway id → release resolution
  digest.mjs                               eval_digest
  records.mjs                              artifacts → records.jsonl
  record.schema.json                       schema_version 1 (the cross-repo contract)
  publish.mjs                              validate + immutable Blob writes
  *.test.mjs
.github/workflows/eval-benchmark.yml
```

`scripts/eval-experiments` (from `prha/eval-latency`) imports from
`scripts/eval-metrics`, so the two tools share one implementation of every
primitive. Both trees are plain `.mjs` with JSDoc types, tested through
`node --test` in the existing CI step (extend its glob). Nothing is added to
`packages/eve`.

## Milestones

Each milestone is one PR and is independently useful.

### M1: Shared measurement primitives

- Move `events.mjs`, `lifecycle.mjs`, `metrics.mjs`, their tests, and the
  `Measurement` type (`measured` | `unavailable` | `not-applicable`) from
  `prha/eval-latency` into `scripts/eval-metrics/`, preserving authorship
  (`git checkout prha/eval-latency -- <paths>`, then `git mv`).
- Rebase `prha/eval-latency` onto M1. Delete its
  `scripts/eval-experiments/measurements/` and import from
  `scripts/eval-metrics/` instead.
- Add the missing primitives the standard set needs:
  - interval pairing by key (`callId`, `taskId`, input batch id)
  - interval union, for framework ms
  - first-delta-in-step, for time to first token
- Tests: fixture event arrays covering partial, ambiguous, overlapping, and
  out-of-order captures.
- **Exit:** `prha/eval-latency`'s self-modification metrics run unchanged on
  top of the shared module.

### M2: Persist per-eval timing (published `eve`)

- Add `startedAt` and `completedAt` to `buildSummaryArtifact` eval entries,
  `buildResultLine`, and `buildEvalArtifact`.
- Update `artifacts.test.ts`, plus a patch changeset ("eval artifacts now
  record each eval's start and completion time").
- **Exit:** `.eve/evals/<ts>/evals/<id>.json` carries both fields.

### M3: Standard metric derivation (`standard.mjs`, `gaps.mjs`)

- `deriveAttemptMetrics(evalArtifact) → { metrics_version, metrics: Record<string, Measurement> }`
  for every row of the design doc's standard-set table. It reads `sessions[]`
  from the detail JSON, not the primary-only `events.ndjson`.
- Rules from the design doc:
  - human wait is excluded from latency aggregates
  - a missing `costUsd` on any step makes cost `unavailable`, never zero
  - framework ms = Σ turn time − |union(model, tool, task, compaction, human-wait)|
- Gap classification:
  - error before the first `step.completed`
  - eval timeout with zero completed steps
  - infra failure codes from `step.failed`/`session.failed`

  Keep the list of gap codes explicit and tested.

- Tests: golden derivations over committed, trimmed event fixtures taken from
  real `agent-tools` / `agent-subagents` / `agent-tasks` runs. These are
  small JSON files under `scripts/eval-metrics/fixtures/`, not
  `packages/eve/test/fixtures/`.
- **Exit:** running the script over a local `.eve/evals` tree prints a full
  metric set with coverage.

### M4: Record contract (`records.mjs`, `record.schema.json`)

- One record per (fixture, eval, model, world, attempt). Fields:
  - keys: `github_run_id`, `run_attempt`, `fixture`, `eval_id`, `model_id`,
    `world`, `attempt` (`world` is in the key because the mock legs of
    different worlds share `model_id: "mock"`)
  - identity: `eval_digest`, `model_release`, `judge_model`, `world`
  - x-axis: `sha`, `eve_version` (from `runtimeIdentity.eveVersion`)
  - context: runner OS, `started_at`
  - correctness: verdict and assertions, with per-assertion name, severity,
    score, and passed
  - `outcome` (`completed` | `timed_out` | `skipped` | `parked` | `gap`)
  - `metrics_version`, `metrics`, `bundles`
  - `artifact_path`: relative path of the raw tree in Blob
- Validate against the JSON Schema in tests (hand-rolled validator; no
  new dependency).
- **Exit:** the schema is reviewed by the internal-repo owner. This is the
  only cross-repo contract.

### M5: Registry, catalog, plan (`benchmark.json`, `plan.mjs`, `catalog.mjs`, `digest.mjs`)

- `e2e/benchmark.json` as in the design doc. Fixtures listed there must
  exist and have `evals/`; reuse `discoverEvalIds` from
  `.github/scripts/discover-e2e-fixtures.mjs` (export it) rather than
  duplicating.
- `catalog.mjs` fetches the AI Gateway model catalog once. If any registry
  id is missing, it fails with a precise message naming the id. Otherwise
  it emits `{ id, release }`. Confirm which catalog field carries the
  release date, and mirror eve-bench's pinning logic.
- `plan.mjs` emits:
  - `live_matrix`: fixture × model × attempt
  - `mock_matrix`: fixture × world, one attempt each
  - the resolved registry snapshot (models, releases, judge), passed to
    publish as an artifact

  Dispatch inputs narrow models, fixtures, and attempts.

- Nightly skip: compare `main` HEAD against the head SHA of the last
  successful `eval-benchmark.yml` run (`gh run list --workflow
eval-benchmark.yml --branch main --status success -L1`). No Blob read
  needed.
- **Exit:** `node scripts/eval-benchmark/plan.mjs` prints a valid matrix
  locally.

### M6: Workflow (`eval-benchmark.yml`)

- Triggers: `schedule` (nightly), `workflow_dispatch` (inputs: `models`,
  `fixtures`, `attempts`), and the dispatch from `release.yml` (see gap 8).
  No `pull_request`.
- `plan` fails unless `github.ref == 'refs/heads/main'`.
- `run-live` (`continue-on-error`, `fail-fast: false`, env
  `AI_GATEWAY_API_KEY` + `EVE_E2E_MODEL`) reuses the e2e-local setup steps:
  - build `eve` and the extension fixtures, then run `e2e:prepare`
  - `eve eval` with no tag filter, so benchmark evals are included once
    phase 2 adds them (no `--strict`; failures are data)
  - upload the single `.eve/evals/<ts>` tree plus `meta.json` (`sha`,
    `attempt`, `model`, `world`, `runner.os`) with `retention-days: 1`

  Factor the shared setup into a composite action only if duplication
  becomes painful.

- `run-mock` follows the same shape with `EVE_E2E_MODEL=mock` and
  `--exclude-tag real-model`. The postgres leg reuses the e2e-postgres
  service container and env.
- `publish` runs `needs: [plan, run-live, run-mock]` with `if: always()`:
  - checks out `main` at the planned SHA
  - downloads every artifact and validates the layout
  - runs `records.mjs`, then `publish.mjs`

  It is the only job with `EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN`. Missing
  legs become `gap` records (outcome `gap`, reason `job-missing`), so
  coverage stays honest.

- `concurrency: eval-benchmark-main`, `cancel-in-progress: false`.
- **Exit:** a manual dispatch with one fixture × one model × one attempt
  publishes to Blob end to end.

### M7: Publication (`publish.mjs`)

- Blob layout, all private and immutable (`allowOverwrite: false`), using
  the `putImmutable*` pattern from `apps/package-artifacts/scripts/build.mjs`:

  ```text
  runs/<github_run_id>/<run_attempt>/manifest.json    sha, eve_version, registry snapshot, schema_version, record count
  runs/<github_run_id>/<run_attempt>/records.jsonl
  runs/<github_run_id>/<run_attempt>/raw/<fixture>/<model>/<world>/<attempt>/...   raw leg artifact
  ```

  Write `manifest.json` last, so ingest treats its presence as "run
  complete".

- Add `@vercel/blob` as a root `devDependency`, pinned to the version
  `packages/eve` already uses (2.8.0); `apps/package-artifacts`' 2.4.0 would
  re-resolve optional peers across the workspace lockfile. This keeps `eve`'s
  runtime dependencies unchanged.
- **Exit:** re-running publish for the same run id with identical content
  is a no-op, and with different content it fails loudly.

### M8: Phase 1 rollout

- Seed `e2e/benchmark.json` with `agent-tools`, `agent-subagents`, and
  `agent-tasks`. Before seeding, run each fixture under every registry model
  via dispatch, and drop any eval that is flaky for non-model reasons.
- Enable the nightly schedule. Watch cost for a week, then settle the
  budget open question with real numbers.
- Hand off the schema to the internal repo.

### M9: Phase 2 benchmark lane (later)

- Add `evals/benchmark/` support: the `benchmark` tag is required there and
  forbidden elsewhere. Add it as a new rule in `scripts/guard-invariants.mjs`
  with a why/fix message.
- `e2e-local`, `e2e-vercel`, and `e2e-postgres` add `--exclude-tag
benchmark`.
- `discover-e2e-fixtures.mjs` excludes `benchmark/*` from `modelShards`
  completeness checks.
- Add the self-modification fixture bundle (`bundles/self-modification.mjs`)
  once `eval-experiments` and this work share M1.

## Validation

- `node --test` over `scripts/eval-metrics` and `scripts/eval-benchmark` in
  the existing CI step. These tests carry most of the correctness risk
  (derivation and gap classification).
- `artifacts.test.ts` for M2.
- End to end: manual `workflow_dispatch` runs on `main`. There is no PR
  trigger, so workflow changes are validated post-merge by dispatch. Keep
  M6 small and land it behind an empty `fixtures` list if needed.

## Implementation notes

Decisions taken while implementing M1–M7 that refine the plan above:

- **Root sessions.** Latency, attribution, cost, tokens, and counts read
  the sessions the eval opened (not linked by `agent.started` or a subagent
  `invocation`). Repeated captures of one session merge by `sessionId`.
  Reliability counts read every captured session.
- **Attribution is a partition.** Inside root turns, time goes to the first
  matching bucket: human wait, task, tool, compaction, model step; the rest
  is framework ms. The parts add up to turn ms. Task outranks tool so a
  `task_wait` call blocking on delegated work counts as task time, and tool
  outranks model because in-process tools run inside their step.
- **Abandoned work closes at its turn's end.** A step cut off by a session
  limit or a cancelled turn's open actions end at the turn's terminal event
  instead of making the attempt unavailable.
- **Human-wait pairing.** `approval.settled` also settles approvals that
  only went through `input.requested`, so only pending `approval.candidate`
  events open approval intervals. `authorization.required` does not always
  carry `attemptId`, so sign-ins pair by turn and connection name.
- **Expected evals.** Each run leg uploads `eve eval --list --json` output
  under its tag filters. A leg that uploaded nothing falls back to the
  fixture's discovered eval files, so a missing mock leg also reports gaps
  for its `real-model` evals.
- **Concurrency.** `e2e/benchmark.json` `concurrency` sets `max-parallel`
  for live legs (default 8) and `eve eval --max-concurrency` for every leg
  (default 1). Live legs are ordered attempt → fixture → model, so each wave
  spans models. This keeps gateway load to about one session per model and
  stops evals from sharing a runner, which skews framework ms and event
  timestamps. Timings from e2e-local PR runs put a full 10-model run at about 65
  minutes. Every manifest records the setting, because changing it changes
  measured latency.
- **Model slots.** Registry entries are slots (high, mid, and low tiers
  per major lab where the lab has a current model for the tier, plus each
  open-weight family's main model; `openai-low` is eve's default model). A slot's `id` moves to its lab's successor model.
  Records carry `model_slot` to follow a tier across releases; `model_id`
  and `model_release` stay in the comparability identity.
- **Model-independent evals.** Some `agent-subagents` evals script every
  model call with eve's mock models, even on live legs. A live-leg eval
  whose model steps all ran on another model is excluded from records, so
  it does not count toward that model's pass rate or latency. The mock
  track still measures it. Evals with no model step stay, so they can
  surface as gaps.
- **Judge.** `e2eJudgeModel()` reads `EVE_E2E_JUDGE_MODEL`, which the
  workflow sets from the registry, so `judge_model` is the judge that ran.
- **Model release.** The AI Gateway `/v1/models` entry's `released` (Unix
  seconds), as a `YYYY-MM-DD` date. eve-bench's pinning logic is private,
  so this has not been checked against it.
- **Golden fixtures** are trimmed mock-model captures of `agent-tools` and
  `agent-subagents`. Every `agent-tasks` eval is `real-model`, so a live
  capture should be added after the first benchmark run.

## Open questions for this plan

- Gap rule: is the proposed split right? Proposal:
  - gap: `MODEL_CALL_FAILED` with an HTTP 429/5xx or network-level
    `details`, and `UND_ERR_*_TIMEOUT`
  - real failure: `MODEL_CALL_FAILED` with any other 4xx (for example,
    context too long), and `OUTPUT_SCHEMA_NOT_FULFILLED`
  - excluded from scoring: CI or setup errors before the eval sends its
    first message
- Blob store: give this its own store and token (`EVE_BENCHMARK_BLOB_*`)
  rather than sharing eve-bench's. That store's layout lives in the private
  eve-bench action and isn't visible from this repo.
