---
issue: https://github.com/vercel/eve/pull/6100
status: proposed
last_updated: "2026-11-06"
---

# Judge rationales

## Decision

A judge's reason comes from the call that produced its score, and eve reports
it in the assertion's `message`. eve never asks a second model to justify a
score it didn't produce.

1. **Ask for the right score first.** When a judge grades several criteria,
   batch them, one question per criterion. Each score then says which criterion
   failed, with no prose at all. The judge's batch form already does this; its
   docs gain this use as an example.
2. **Report a rationale when the decision model returns one.** eve's judge
   passes a decision answer's optional `rationale` through to `message`.
3. **Grade with prose through `t.score`.** An author who wants a language
   model to score and explain in one reply already can: `t.score` accepts
   `{ score, message }` from the same model.

## Problem

A judge score arrives with no reason. eve fills the judge's `message` with the
graded state, the question, and the raw answer
([`formatJudgeDetail`](../packages/eve/src/evals/judge.ts)). Those three values
are already in the assertion's `metadata`. `message` is documented as the
"concise human-readable reason" and reaches the console, artifacts, JUnit,
Braintrust, and Datadog, so the one field every reporter shows holds a dump.

eve has no reason to put there.
[Decision answers](https://ai-sdk.dev/docs/ai-sdk-core/decisions) carry only
`choice`, `score`, and `probabilities`.

## Semantics

### The decision contract

Decision answers gain an optional `rationale: string`, filled by decision
models that can state one, such as adapters that prompt a language model. A
model that returns only a distribution, such as Jev, leaves it absent. A
caller asks for rationales with a decision call option, because they cost
output tokens. This is an AI SDK change; eve depends on it and fabricates
nothing in its absence.

### The judge

- **Opt-in.** `judge: { rationale: true }` requests rationales. It is a judge
  setting like `model`, settable per call, per eval, and per project, and
  follows the same rule: a per-eval `judge` replaces the project's whole.
- **`message` is the reason.** With a rationale, `message` is the outcome
  followed by the rationale. eve writes the outcome itself: the chosen and
  expected options, the probability, or the rubric level. For example:
  `chose "declined", expected "answered": The reply refuses because …`. So
  `expected` is never sent to the model, and the reader still sees why the
  score is 0.
- **Without a rationale, nothing changes.** `message` keeps today's text.
- **Metadata keeps the evidence.** State, question, raw answer, and usage stay
  in `metadata`, as today, and the rationale joins them.
- **The score is the decision's.** A rationale never changes the score,
  threshold, or verdict.

No `AssertionResult` field is added, and no reporter changes: they already show
`message`.

## Alternatives

- **A second model that explains the decision afterwards.** It would argue for
  a conclusion it didn't reach, and for a distribution-only model there is no
  reasoning to recover. Its text would read as the reason anyway.
- **A new `explanation` field.** It would duplicate `message` and need a
  follow-up in every reporter.
- **Making the judge generative.** eve's judge is built on the decision API's
  typed answers and validation. Authors who want a generative grade have
  `t.score`.
