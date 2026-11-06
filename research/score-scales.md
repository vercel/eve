---
issue: https://github.com/vercel/eve/pull/6101
status: proposed
last_updated: "2026-11-06"
---

# Score scales on assertions

## Decision

An assertion result states what kind of measurement its score is, so a reader
can tell a probability from a rubric position. The scale comes from what
produced the score, and eve records only what it knows.

| scale                          | the score is                                                                     | from                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `{ type: "binary" }`           | 0 or 1                                                                           | scoped methods, `includes`, `equals`, `matches`, `satisfies`, and `choice` judges |
| `{ type: "probability" }`      | the judge's probability that the answer is yes                                   | `boolean` judges and criteria strings                                             |
| `{ type: "rubric", criteria }` | a position on `criteria`, worst first, over the last index; can fall between two | `score` judges; `criteria` is the question's, verbatim                            |
| absent                         | a number from 0 to 1                                                             | `similarity`, and any `t.score` or custom assertion that declares none            |

Severity never changes a scale: a gated `similarity` has none, and a soft
`includes` is binary.

A scale belongs to the measurement, so it is declared where the measurement
is made. `AssertionEvaluation`, which `t.score` accepts and `t.check`
evaluators return, and the custom `Assertion` object each gain an optional
`scale`. Assertion handles don't, so no caller can relabel one of eve's own
assertions.

```ts
t.score({ score: grade.probability, scale: { type: "probability" } }).label("faithfulness");
```

`AssertionResult` gains `scale`, absent when none was declared. Artifacts and
reporters receive it.

## Problem

A judge score of 0.5 means the middle level of a three-level rubric, or a coin
flip as a probability. eve records what tells them apart only in judge
metadata: `metadata.question` holds the question's `type` and `criteria`.
Metadata is an untyped bag whose keys carry no stability promise, and only
judges fill it. `t.score` and custom assertions have no way to say what their
number is, so a reporter can't show it.

## Semantics

- **Thresholds don't change.** They still apply to the 0–1 score.
- **Labelling is the reporter's job.** A rubric's `criteria` can be strings,
  JSON values, or `null`. eve passes them through as authored, and a reporter
  decides how to show a position between two of them.
- **A choice judge is binary.** Its score is whether the chosen option equals
  `expected`. The chosen option stays in `metadata.answer`.
- **Evaluator identity stays with consumers.** eve reports each result's scale;
  whether a scale change starts a new history is the consumer's decision.
