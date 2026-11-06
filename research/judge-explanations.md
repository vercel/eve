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

`explain` is part of the judge configuration and follows its rules. Per-call
fields override the eval's or project's judge, and a per-eval `judge` replaces
the project's as a whole, so an eval that sets `judge: { model }` has no
`explain` unless it sets one. `explain: false` turns it off for one call. With
no `explain`, judges make no extra request.

## Problem

A judge score has no reason attached. When a judge scores a reply 0 against
several criteria, the reader rereads the reply and guesses which one it missed.

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
  score, `explanation` is absent, and eve logs a warning. An explanation fails
  when its request fails, or when the text for a key is missing, empty, or
  longer than 500 characters. A batch reply is checked per key, and keys that
  name no question are ignored with a warning. An errored judge gets no
  explanation.
- **`expected` stays private.** A choice question's expected option is never
  sent, as for the decision. The explanation model sees the chosen option.
- **One request per decision request.** A batch gets one explanation request
  that returns one explanation per question key.
- **Bounded.** 1–500 characters per explanation, never truncated. Its token
  usage is recorded in assertion metadata, apart from the decision's, and a
  batch's explanation usage is marked shared, as decision usage is.

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

## Consumers

A store that keeps judge scores can persist `explanation` next to each score.
The text describes the graded value, so a store that keeps production
conversations behind access checks applies the same checks to it.
