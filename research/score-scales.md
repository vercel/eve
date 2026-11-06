---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-11-06"
---

# Score scales on assertions

## Decision

An assertion result states what kind of measurement its score is, so a reader
can tell a model's probability from a rubric position. Every assertion eve
builds declares its scale, so a missing scale means only one thing: the author
declared none.

| scale                          | the score is                                                                | eve declares it for                                                           |
| ------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `{ type: "binary" }`           | 0 or 1                                                                      | scoped methods, `includes`, `equals`, `matches`, `satisfies`; `choice` judges |
| `{ type: "probability" }`      | the judge model's reported probability that the answer is yes, uncalibrated | `boolean` judges and criteria strings                                         |
| `{ type: "rubric", criteria }` | a position on `criteria`, worst first, over the last index                  | `score` judges, with the question's criteria verbatim                         |
| `{ type: "ratio" }`            | a fraction of a known maximum                                               | `similarity`                                                                  |

"Binary" is a new word because "boolean" already names a judge question type,
and boolean judges score a probability, not 0 or 1.

A scale is declared once, on the measurement: `AssertionEvaluation` gains an
optional `scale`. `t.score` accepts it, and a custom assertion returns it from
`evaluate`, as it returns `message` and `metadata` today. Assertion handles
and `Assertion` objects get no scale.

```ts
t.score({ score: grade.probability, scale: { type: "probability" } }).label("faithfulness");
```

`AssertionResult` gains `scale`. It is the contract for what a score means;
`metadata.question` stays diagnostic.

## Problem

A judge score of 0.5 is the middle level of a three-level rubric, or a model
reporting even odds. eve records what tells them apart only in judge metadata:
`metadata.question` holds the question's `type` and `criteria`. Metadata is an
untyped bag whose keys carry no stability promise, and only judges fill it.
`t.score` and custom assertions have no way to say what their number is, so no
reporter can show it.

## Semantics

- **eve checks what a scale claims.** The collector already rejects scores
  outside 0–1 and marks the entry errored. It applies the same treatment to a
  binary score other than 0 or 1, and a rubric with fewer than two criteria.
  Rubric scores can fall between two levels: a decision model reports a
  fractional position.
- **A probability is not confidence.** The judge docs state boolean scores are
  model estimates, not calibrated confidence. Reporters show the number, never
  "N% likely".
- **Thresholds don't change.** They still apply to the 0–1 score.
- **Same-name results keep one scale.** Reporters merge assertions that share a
  name. When the merged results declare different scales, eve warns, as it does
  for differing soft scores, and the merged entry has no scale.

## Reporters

| reporter            | shows                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| console             | binary as pass or fail; a rubric as its position, such as `level 2 of 3` for 0.5 on three levels; others as today |
| artifacts           | `scale` on each assertion result                                                                                  |
| Braintrust, Datadog | `scale` on each entry of `eveAssertionScores` metadata                                                            |
| JUnit               | unchanged                                                                                                         |
