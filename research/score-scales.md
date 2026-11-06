---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-11-06"
---

# Score scales on assertions

## Decision

Every assertion result states the scale its score is on, so a reader can tell
a probability from a rubric position. eve sets the scale for its own
assertions and judges; `t.score` accepts one.

| scale                                 | the score is                                                                          | set by                                |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| `{ type: "categorical", categories }` | one category's value, such as fail (0) or pass (1)                                    | gates; `choice` judges, as fail/pass  |
| `{ type: "probability" }`             | the judge's probability that the answer is yes, 0–1                                   | `boolean` judges and criteria strings |
| `{ type: "ordinal", levels }`         | a position on `levels`, worst first, over the last index; can fall between two levels | `score` judges                        |
| `{ type: "continuous" }`              | a number with no further meaning                                                      | `similarity`; `t.score` by default    |

```ts
t.score(grade).label("faithfulness").scale({ type: "probability" });
```

## Problem

A judge score of 0.5 means "Mostly clear" on a three-level rubric and a coin
flip as a probability. eve knows which it is when it scores: the question type
and its levels are in hand. It then drops them. Only the display name
(`judge.score`, `judge.boolean`) keeps a trace.

Consumers guess. v's publisher derives a scale from its own judge files
([`judgeScale`](https://github.com/vercel/api/blob/d1b542882e6ee573d907cba0a0cf148fa844f17a/agents/v/evals/lib/checks/judge.ts#L97-L99)),
and its contract has only categorical and continuous scales, so probability
and rubric judges both publish as `continuous`. The evals pages then label them
the same way.

## Semantics

- **One scale per key.** A labelled assertion keeps its scale across attempts
  and evals. eve warns when two results with the same key report different
  scales, as it warns for duplicate scores.
- **Thresholds don't change.** They still apply to the 0–1 score.
- **No scale reads as continuous**, which is what every consumer assumes today.
- **Ordinal scores read through their levels.** A reporter can show 0.5 on
  three levels as "Mostly clear", and 0.65 as between "Mostly clear" and
  "Clear and concise".

`AssertionResult` gains `scale`, absent when unknown. Artifacts and reporters
receive it.

## Consumer: v's evaluation contract

v's
[`scaleSchema`](https://github.com/vercel/api/blob/d1b542882e6ee573d907cba0a0cf148fa844f17a/agents/v/lib/evaluations/contract.ts#L38-L56)
gains the two missing types:

| scale         | shape                                                | rule                       | evals pages show                                                             |
| ------------- | ---------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| `probability` | `{ type: "probability" }`                            | completed scores in [0, 1] | `Model judge · <model> · probability`                                        |
| `ordinal`     | `{ type: "ordinal", levels: string[] }`, 2–20 levels | completed scores in [0, 1] | `Model judge · <model> · 3 levels`, and the nearest level next to each score |

The publisher reads `scale` from the eve result. A scale is part of an
evaluator version's identity, so a judge that moves from `continuous` to one of
these needs a version bump and starts a new history. Today none does: all 11 of
v's offline judges are binary and publish as categorical. The online
`request-completeness` judge stays `continuous`, because it is a generated 0–1
grade, neither a probability nor a rubric position.
