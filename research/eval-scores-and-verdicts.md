---
issue: https://github.com/vercel/eve/pull/4563
status: implemented
last_updated: "2026-10-09"
---

# Separate evaluation scores from pass/fail decisions in eve

Expose each evaluator's score and optional pass/fail verdict separately, so
consumers can persist both, including when a threshold fails.

## Motivation

An evaluation store needs the original measurement to compare runs, while CI
needs an acceptance decision. A score of `0.82` must remain `0.82` when a `0.9`
threshold makes the test fail.

Before this change, [`AssertionResult`](../packages/eve/src/evals/types.ts)
reported `passed: true` for assertions without a threshold, wrote `score: 0`
when a scorer threw, and had no identifier other than the display `name`. A
score is a measurement; an assertion is a rule applied to it.

## Authoring contract

`t.score(evaluation)` records a score and returns the ordinary
`AssertionHandle`; `.label(key)` names it, as for every other assertion.
`evaluation` is a number or `{ score, message?, metadata? }`, or a promise of
either. Scores are numeric; boolean assertions keep scoring 0 or 1.

```ts
const grade = await evaluator.evaluate({ input, output, reference });
t.score(grade).label("faithfulness"); // no verdict, never fails

t.score(grade).label("faithfulness").gate(0.9); // fails the eval below 0.9
t.score(grade).label("faithfulness").atLeast(0.9); // marks it `scored`, fatal under --strict
```

A rule does not change the score or rerun the evaluator. Existing assertions
are unchanged; `.label(key)` sets `key` on any of them.

## Persistence contract

Every finalized `AssertionResult`, in reporters' `onEvalComplete` and in the
`.eve/evals/` artifacts, carries:

| field       | meaning                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| `key`       | stable identifier set by `.label(key)`; else absent                                 |
| `score`     | the measurement; absent when the scorer threw                                       |
| `threshold` | effective minimum passing score (a gate defaults to 1); absent when no rule applies |
| `passed`    | verdict of the rule; absent when no rule applies                                    |
| `errored`   | the scorer threw; always a failed outcome, with the error in `message`              |

For `0.82` gated at `0.9`, consumers read `score: 0.82`, `threshold: 0.9`,
`passed: false`. A failed threshold does not prevent persistence. A scorer
that threw has no score, and the other measurements in the same eval still
reach reporters. Reporters that need a number (Braintrust, Datadog) skip
errored entries.

Related precedent: LangSmith separates [feedback recording](https://docs.langchain.com/langsmith/feedback-data-format)
from optional [test expectations](https://docs.langchain.com/langsmith/pytest#expectations).
