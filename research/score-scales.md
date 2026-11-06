---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-11-06"
---

# Score scales on assertions

## Decision

Every assertion result states the scale its score is on, so a reader can tell
a probability from a rubric position. eve sets the scale for its own
assertions and judges. `t.score` and custom assertions declare one.

| scale                                 | the score is                                                                          | set by                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `{ type: "categorical", categories }` | one category's value: fail (0) or pass (1)                                            | scoped methods, `includes`, `equals`, `matches`, `satisfies`; `choice` judges |
| `{ type: "probability" }`             | the judge's probability that the answer is yes, 0–1                                   | `boolean` judges and criteria strings                                         |
| `{ type: "ordinal", levels }`         | a position on `levels`, worst first, over the last index; can fall between two levels | `score` judges                                                                |
| `{ type: "continuous" }`              | a number with no further meaning                                                      | `similarity`                                                                  |

The scale describes the score's shape, so severity doesn't change it: a gated
`similarity` stays continuous, and a soft `includes` stays pass/fail.

```ts
t.score(grade).label("faithfulness").scale({ type: "probability" });
```

A custom `Assertion` passed to `t.check` or `t.require` declares its scale with
an optional `scale` property. `t.score` and custom assertions without one have
no scale.

## Problem

A judge score of 0.5 means "Mostly clear" on a three-level rubric and a coin
flip as a probability. eve records what tells them apart, but not as a
contract. A judge result's `metadata.question` holds the question's `type` and
`criteria`, and `metadata.answer` holds the raw answer. Metadata is an untyped
bag: its keys can change without notice, and only judges fill it. `t.score`
and custom assertions have no equivalent, so a reporter has no way to read
their scale.

So consumers keep their own copy of each scale. A store that knows only
categorical and continuous scales publishes probability and rubric judges both
as continuous, and shows them the same way.

## Semantics

- **One scale per key.** A labelled assertion keeps its scale across attempts
  and evals. eve warns when two results with the same key report different
  scales, as it warns for duplicate scores.
- **Thresholds don't change.** They still apply to the 0–1 score.
- **No scale reads as continuous**, which is what every consumer assumes today.
- **Ordinal levels are labels.** A rubric criterion can be a string, a JSON
  value, or `null`. A string criterion is its own label. Any other criterion is
  labelled by its position, `Level 1` worst. The full criterion stays in
  `metadata.question`. A reporter can then show 0.5 on three levels as its
  middle label, and 0.65 as between the middle and best labels.

`AssertionResult` gains `scale`, absent when unknown. Artifacts and reporters
receive it.

## Consumers

A store can read `scale` from the eve result, so it needs no copy of the
mapping. A store that treats a scale as part of an evaluator's identity starts
a new history for an evaluator whose scale changes, such as a rubric judge that
was published as continuous.
