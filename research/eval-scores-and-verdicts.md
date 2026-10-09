---
issue: https://github.com/vercel/eve/pull/4563
status: implemented
last_updated: "2026-10-09"
---

# Separate evaluation scores from pass/fail decisions in eve

Expose each evaluator's raw score and optional pass/fail verdict separately, so
consumers can persist both, including when a threshold fails.

## Motivation

An evaluation store needs the original measurement to compare runs, while CI
needs an acceptance decision. A score of `0.82` must remain `0.82` when a `0.9`
threshold makes the test fail.

eve already carried numeric scores, thresholds, and verdicts on
[`AssertionResult`](../packages/eve/src/evals/types.ts), but blurred the two:
tracked-only assertions reported `passed: true`, scorer errors wrote `score: 0`,
and the only stable identifier was the display `name`. A score is a
measurement; an assertion is a rule applied to it. The result record now
reflects that.

## Authoring contract

`t.score(key, evaluation)` records a measurement under a stable key and returns
the ordinary `AssertionHandle`. `evaluation` is a number or
`{ score, message?, metadata? }`, or a promise of either, so code and model
evaluators both fit. Scores are numeric; boolean assertions keep scoring 0 or 1.

```ts
const grade = await evaluator.evaluate({ input, output, reference });
t.score("faithfulness", grade); // tracked only: no verdict, never fails

t.score("faithfulness", grade).gate(0.9); // fails the eval below 0.9
t.score("faithfulness", grade).atLeast(0.9); // marks it `scored`, fatal under --strict
```

Recording imposes no acceptance rule, and a rule never rewrites the score or
reruns the evaluator. Existing assertions are unchanged convenience layers over
the same lifecycle; `.label(key)` gives any of them a structured key.

## Persistence contract

Every finalized `AssertionResult`, in reporters' `onEvalComplete` and in the
`.eve/evals/` artifacts, carries:

| field       | meaning                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| `key`       | stable identifier from `t.score(key, …)` or `.label(key)`; else absent              |
| `score`     | raw measurement; absent when the scorer threw                                       |
| `threshold` | effective minimum passing score (a gate defaults to 1); absent when no rule applies |
| `passed`    | verdict of the rule; absent when the entry is tracked only                          |
| `errored`   | the scorer threw; always a failed outcome, with the error in `message`              |

For `0.82` gated at `0.9`, consumers read `score: 0.82`, `threshold: 0.9`,
`passed: false`. A failed threshold never prevents persistence. Execution
errors are distinct outcomes with no fabricated score, and measurements that
completed still reach reporters. Reporters that need a number (Braintrust,
Datadog) skip errored entries.

Related precedent: LangSmith separates [feedback recording](https://docs.langchain.com/langsmith/feedback-data-format)
from optional [test expectations](https://docs.langchain.com/langsmith/pytest#expectations).
