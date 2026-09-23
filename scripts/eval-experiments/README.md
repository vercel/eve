# Eval latency experiments

This internal harness compares correctness-eval runs across immutable git snapshots. It does not add latency assertions or alter required checks.

## Dispatch

Create `experiments/<name>.json` from the manifest shape in `research/eval-latency-experiments.md`, ensuring each candidate SHA is a full commit and each baseline-to-candidate diff is confined to the two allowed agent files. Push the experiment branch and dispatch from a trusted same-repository ref:

```sh
gh workflow run eval-experiment.yml --ref my-experiment-branch \
  -f manifest=experiments/self-modification-latency.json
```

Every candidate SHA describes its whole tree. Restore the baseline files between independent variants. Model aliases are resolved from `e2e/matrix.json` and full model IDs are recorded. The manifest-only commit is experiment metadata, not a candidate measurement. Metrics profiles are registered under `scripts/eval-experiments/profiles/`; a profile controls supported fixture/eval selections, allowed variant diff paths, fixture restoration checks, observed model settings, and metric extraction. The planner and comparator consume profile metadata rather than embedding those selectors. The Actions run executes the unmodified fixture correctness eval with `--strict --verbose --max-concurrency 1 --skip-report`; fixture timeout, judge, setup, teardown, and source restoration remain authoritative.

## Artifacts and local report regeneration

The workflow uploads the immutable plan, invocation records, each timestamped eval artifact directory, and the generated JSON/Markdown report. Download artifacts with `gh run download <run-id>`. To normalize a downloaded execution artifact tree and compare it against the downloaded plan:

```sh
node scripts/eval-experiments/extract.mjs ./execution-artifacts ./samples.json
node scripts/eval-experiments/compare.mjs ./plan.json ./samples.json ./report.json ./report.md
```

The extractor reads per-session event arrays only; the task-level events NDJSON file is intentionally not concatenated. Event references retain their IDs and timestamps for audit. Samples missing execution or metrics remain visible in the comparison output.

## Metrics and interpretation

`creationElapsedMs` is the parent `turn.started` timestamp to the matching fresh child's `turn.completed`; `childTurnMs` is the child turn duration; `childToolCalls` counts distinct child action call IDs. These server-event durations exclude ingress, delivery, build/startup, verification conversations, and teardown. Parent and child work can overlap; never sum the parent-to-child interval with child duration. Terminal failures, parked turns, and ambiguous/missing event correlations are incomplete, not zero-duration success.

Correctness counts include all planned repetitions. Latency uses only paired repetitions where both variants pass strict correctness and have complete metrics; this conditional view does not establish preserved quality. Five repetitions are exploratory, not a tail estimate. Provider caches, routing, and model versions are not frozen by source SHAs. A faster candidate with a correctness regression is not a winner. Confirm any selected candidate against a fresh baseline with more repetitions.

The `self-modification-v1` profile accepts all seven fixture evals for strict correctness execution, but only its simple single-turn creation cases currently have a latency metric. Repair/approval cases and the background-workflow case are retained as explicit incomplete measurements until their episode or task lifecycle can be attributed without mixing verification or approval waits. Do not treat an all-eval run's speed comparison as a full-suite aggregate while those metrics are incomplete.
