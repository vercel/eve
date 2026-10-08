---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-10-08"
---

# Separate evaluation scores from pass/fail decisions in eve

Expose each evaluator's raw score and optional pass/fail verdict separately, so
consumers can persist both, including when a threshold fails. This document is
the task for a follow-up implementation; API names below are illustrative.

## Motivation

An evaluation store needs the original measurement to compare runs, while CI
needs an acceptance decision. A score of `0.82` must remain `0.82` when a `0.9`
threshold makes the test fail.

eve already exposes numeric scores, thresholds, and verdicts through
[`AssertionResult`](../packages/eve/src/evals/types.ts), and supports scores
without thresholds. Build on that separation. Today, tracked-only assertions
report `passed: true`, scorer errors carry `score: 0` plus `errored: true`, and
boolean assertions use numeric `0`/`1`. The proposed measurement contract makes
these distinctions explicit and gives consumers a structured evaluator key.

## Authoring contract

- Evaluators return `{ score: boolean | number, message?, metadata? }`. Either
  code or an LLM can produce either output type. Return numeric scores unchanged.
- Recording a result imposes no acceptance rule. Associate the recorded score
  and any later acceptance rule with the same evaluator key.
- An optional acceptance rule determines pass/fail independently. Numeric
  thresholds compare numbers; boolean acceptance compares against an expected
  boolean without converting the measurement to a number.
- Reuse existing judge and code evaluation logic. Code evaluators should receive
  supported snapshots of output, events, and tool calls.

Illustrative authoring API, not currently shipped:

```ts
const result = await evaluator.evaluate({ input, output, reference, signal });
t.recordScore({ key: evaluator.key, ...result });

// Optional required acceptance rule for a numeric evaluator:
t.expectScore(result).atLeast(0.9);
```

Here the expectation fails the test below `0.9`; it does not replace the score
or rerun the evaluator. Omitting the expectation records only a measurement.
This proposed required expectation is distinct from the existing soft
`.atLeast(...)` assertion behavior.

## Persistence contract

Expose completed measurements and their optional acceptance results through
finalized results, JSON artifacts, and the existing reporter completion
lifecycle. Consumers must not parse display labels to recover evaluator keys.

Illustrative result shape and storage API:

```ts
// After eve finalizes an example, including threshold failures:
for (const evaluation of finalizedExample.evaluations) {
  await evaluationStore.write({
    runId: finalizedExample.runId,
    exampleId: finalizedExample.exampleId,
    evaluatorKey: evaluation.key,
    score: evaluation.score,
    threshold: evaluation.threshold ?? null,
    passed: evaluation.passed ?? null,
  });
}
```

For `{ score: 0.82, threshold: 0.9, passed: false }`, persist all three values
unchanged. With no acceptance rule, omit `threshold` and `passed`; this consumer
stores them as `null`. A boolean rule has a verdict without a numeric threshold.
A failed threshold must not prevent persistence.

Execution errors are separate outcomes, with no completed measurement; they
must not become `false` or `0`. Preserve error diagnostics and any other
measurements that completed successfully. The loop above consumes completed
measurements only.

## Implementation task and acceptance criteria

Add the authoring and reporting contract above, reusing the current assertion
collector and reporter lifecycle. Keep existing assertions as a convenience
layer with their current behavior. Preserve judge configuration, cancellation,
diagnostics, and batch execution. Add public documentation and focused coverage
that proves:

- `0.82` with a required `0.9` threshold produces a failing verdict while
  reporters and JSON retain `score: 0.82`, `threshold: 0.9`, and `passed: false`.
- A score exactly at the threshold passes. A score without an acceptance rule
  has no measurement-level verdict and does not fail the test.
- Boolean `false` and numeric `0` survive recording and persistence unchanged.
  An explicit boolean acceptance rule produces a separate verdict.
- A scorer error produces a distinct error outcome and no fabricated score;
  completed measurements still reach reporters before the CLI exits.
- Each acceptance result is associated with its recorded evaluator key;
  recording and thresholding do not execute an evaluator twice.

The existing score-plus-assertion contract can remain unchanged, but consumers
would keep decoding its conventions for labels, unthresholded results, and
errors. Prefer an explicit measurement contract while reusing that lifecycle.
Choose the smallest public API that satisfies these semantics during
implementation; no separate runner or storage backend is required.

Related precedent: LangSmith separates [feedback recording](https://docs.langchain.com/langsmith/feedback-data-format)
from optional [test expectations](https://docs.langchain.com/langsmith/pytest#expectations).
