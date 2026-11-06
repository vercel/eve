---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-11-06"
---

# Judge explanations

## Decision

Add an opt-in explanation to `t.judge`. After the decision model answers, eve
asks a language model why that answer fits the evidence, and records one or two
sentences on the assertion as `explanation`. The score stays the decision's.

```ts title="evals/evals.config.ts"
export default defineEvalConfig({
  judge: {
    model: "typesafe-ai/jev",
    explain: { model: "anthropic/claude-haiku-4.5" },
  },
});
```

`explain` resolves like `model` and `modelOptions`: per call, then per eval,
then the project default. `explain: false` turns it off for one call. With no
`explain`, judges make no extra request.

## Problem

A judge score has no reason attached. When `reply-meets-reference-criteria`
scores a v case 0, the reader rereads the reply and guesses which part of the
criteria it missed.

eve has no reason to pass on. [Decision answers](https://ai-sdk.dev/docs/ai-sdk-core/decisions)
carry `choice`, `score`, and `probabilities`, and nothing else; the
[judge docs](../docs/evals/judge.mdx#diagnostics) state that decision models
don't promise a written rationale. The assertion `message` holds the graded
state, the question, and the raw answer. That is a debugging dump, not a reason.

## Semantics

- **Written after the answer.** The explanation model receives the decision's
  state, the question, and the answer, and states the evidence for that
  answer. It is not the decision model's reasoning, so eve calls it an
  explanation everywhere, never reasoning.
- **Never changes the outcome.** Score, threshold, and verdict come from the
  decision alone.
- **A failed explanation is not a failed assertion.** The assertion keeps its
  score, `explanation` is absent, and eve logs a warning. An errored judge
  gets no explanation.
- **`expected` stays private.** A choice question's expected option is never
  sent, as for the decision. The explanation model sees the chosen option.
- **One request per decision request.** A batch gets one explanation request
  that returns one explanation per question key.
- **Bounded.** At most 500 characters per explanation. Its token usage is
  recorded in assertion metadata, apart from the decision's.

## Result shape

`AssertionResult` gains one field:

| field         | meaning                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `explanation` | Why the judge's answer fits the evidence, written after the answer; absent when not requested or failed |

The console prints it under a failed or scored judge. Artifacts and custom
reporters receive it. Braintrust and Datadog each need a follow-up to attach it
where their APIs accept text.

## Alternatives

- **A rationale from the decision provider.** Native decision models such as
  Jev return a distribution, not text. If the AI SDK decision contract adds an
  optional rationale, eve records it as `explanation` and skips the extra
  request.
- **A generative judge returning `{ answer, reason }`.** One request, but it
  gives up the typed answers, probabilities, and validation the judge is built
  on.

## Consumer: v's evaluation store

v publishes eve scores through its
[evaluation contract](https://github.com/vercel/api/blob/d1b542882e6ee573d907cba0a0cf148fa844f17a/agents/v/lib/evaluations/contract.ts#L85-L89).
A score is `{ evaluatorKey, status, value }`, and the evals pages' Comment
column reads `v_evaluation_scores.comment`, which nothing writes today. The
contract gains one optional score field:

| field     | type                | rule                                                                                                     |
| --------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `comment` | string, 1–500 chars | Offline snapshots only. Online snapshots reject it, because production text stays behind session access. |

The publisher copies `explanation` into `comment`. The comment is not part of
the evaluator definition, so adding it needs no version bump.
