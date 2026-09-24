# Eval experiments

This internal harness compares immutable eve source revisions and named runtime configurations over existing evals. `eve eval` remains the execution engine; the harness only plans scheduled runs, archives evidence, derives measurements, and compares paired samples. It is not a public `eve` command and does not make experiments part of product CI.

## Define an experiment

Create `experiments/<name>.mjs` and export a default `Experiment` object. The checked-in `experiments/self-modification.mjs` is a complete self-modification experiment definition. Selections currently support only eval files with a direct `export default defineEval(...)`; array-exported eval files are rejected until the planner can expand their indexed IDs. Runs are serial; parallel execution is not configurable.

Both matrix axes are named maps. Omit `matrix.source` to run against the planner checkout's HEAD: the planner records one source entry named `head` with the full commit SHA. In GitHub Actions, this is the PR head commit or dispatched revision, not a moving branch reference. Uncommitted source changes are not included. Set `analysis.compare.axis` to `"configuration"` and choose a configuration baseline when using this default; the compared axis requires at least two entries. An explicit source map must be non-empty and use full commit SHAs, not `"HEAD"`.

Source values are whole immutable commit trees and configuration values are explicit combinations of full model IDs and reasoning settings. Shared settings are merged with each configuration field-by-field in the `parent` and `selfModification` scopes. Overrides win; a configuration that overrides an authored model default changes that source behavior and should be avoided in an instruction-change experiment. Omitted reasoning means the fixture default. The fixture adapter rejects unknown scopes and source checkouts that do not implement scoped overrides. Judge configuration remains fixed.

For the self-modification fixture, `parent` controls the user-facing agent that receives the request, delegates the edit, and uses the changed agent in verification conversations. `selfModification` controls the child agent that edits the source. Neither override is required: omitted models keep their authored defaults. To isolate editing-model differences, vary only `selfModification`; to compare each model across the whole workflow, override both scopes in each configuration.

Measurement definitions and derivation logic live together in `experiments/`; see `experiments/self-modification-metrics.mjs`. The experiment owns metric names, event selection, and which missing evidence makes each metric unavailable. The harness provides reusable helpers under `scripts/eval-experiments/measurements/`, not experiment-specific metric bundles:

- `events.mjs`: `captureSessions` validates and deduplicates event identities and provides evidence references; `selectEvents` filters by event type and exact data fields.
- `lifecycle.mjs`: `delegatedSessions` verifies child invocation links, `parentTurnStarts` finds unique parent starts, and `completedTurns` pairs all turns in selected sessions, including resumed turns.
- `metrics.mjs`: `elapsedTime` measures a wall-clock span, `totalTurnDuration` sums active turn durations, and `totalToolCalls` counts distinct requested tool-call IDs per session. Each returns a measurement with evidence or an unavailable reason.

Lifecycle helpers return `status: "ready"` with the selected evidence or `status: "unavailable"` with a reason. Malformed capture shapes and conflicting identities throw instead. Helpers do not decide dependencies between metrics: for example, the self-modification experiment requires valid child durations before counting tools, while `totalToolCalls` itself does not require timestamps.

Each measurement definition is a plain synchronous ESM object. Its declared metric keys and metadata define report metrics; namespace is assigned in the experiment. Derivation receives the validated captured eval, including its eval ID, and must be deterministic and side-effect-free. A thrown derive function or invalid metric result is an analysis error. Correctness, execution health, and measurement missingness remain independent.

## Dispatch

Commit and push the definition and imported measurement modules before triggering a run. Only run trusted repository code: experiments execute with model-provider credentials.

### Run on a draft PR

Add the `run-eval-experiment` label to a same-repository PR, including a draft, to run `experiments/self-modification.mjs` at that PR's head commit:

```sh
gh pr edit <pr-number> --add-label run-eval-experiment
```

The label must already exist in the repository. If needed, a maintainer can create it with `gh label create run-eval-experiment`. Fork PRs are excluded. The workflow uses `pull_request`, so it can run before the workflow is merged to `main`.

Only adding the label triggers the experiment; opening the PR, pushing commits, or marking it ready for review does not. Remove and re-add the label to run again at the latest PR head. An existing run continues at its original commit.

### Dispatch another definition

Once the workflow exists on the repository's default branch, you can manually dispatch any committed experiment definition from a trusted repository ref:

```sh
gh workflow run eval-experiment.yml --ref my-experiment-branch \
  -f definition=experiments/self-modification.mjs
```

The workflow does not accept arbitrary uploads. GitHub Actions is the live execution environment; do not run provider-backed e2e suites locally. The planner resolves full source SHAs, fixture/eval selections, requested settings, measurement schemas, and a deterministic counterbalanced schedule into `plan.json`. Source comparisons retain baseline-to-candidate diff evidence but do not apply patches to another checkout.

## Artifacts and offline reanalysis

The Actions run summary contains the Markdown report; the workflow does not post a PR comment. The workflow archives `plan.json`, per-invocation records, raw logs and timestamped eval artifact directories, normalized samples, and JSON/Markdown reports for 14 days. Download with `gh run download <run-id>`. To rederive from the downloaded execution evidence without launching an eval:

```sh
node scripts/eval-experiments/extract.mjs ./execution ./plan.json ./samples.json ./experiments/self-modification.mjs <analysis-revision>
node scripts/eval-experiments/compare.mjs ./plan.json ./samples.json ./report.json ./report.md
```

The default analysis module should be the pinned experiment revision's module. Extraction checks the definition and imported module hashes against the plan. If intentionally using changed modules, retain the original plan and invocation provenance and supply a distinct analysis revision; never silently replace the original report meaning.

## Reading reports

Comparisons remain separate by eval, fixed matrix entry, and metric. No cross-eval or cross-model aggregates are generated. Paired metrics require both evals to pass, both invocations to be healthy, and that metric to be measured. Zero is a valid measurement; a zero denominator does not produce a ratio. Missing samples, unavailable measurements, not-applicable measurements, execution errors, and analysis errors are distinct. A correctness regression is never labeled a performance win.

Self-modification metrics cover all seven evals in `experiments/self-modification.mjs`. `parentTurnToFinalChildCompletion` measures from the earliest parent turn that delegates to self-modification through the latest corresponding child turn completion. `totalChildDuration` sums each child turn's own duration, and `toolCalls` counts distinct requested tool call IDs across those turns. The eval ID comes from the captured artifact; the measurement definition does not need to repeat the experiment's eval selection. This includes resumed child turns after approval and subsequent repair delegations. The wall-clock span includes pauses between child turns and is closer to end-to-end child-flow latency, but can include approval and scheduling delays. Summed child duration excludes those gaps and better isolates time spent in child turns, but omits time between turns. Both exclude ingress, startup/build, verification conversations, and teardown, so they do not represent full eval runtime.

Harness tests run with `pnpm test:eval-experiments`. Internal definition typing runs with `pnpm typecheck:eval-experiments`.
