---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: implemented
last_updated: "2026-09-18"
---

# Evaluation models for eval judges

`t.judge(...)` uses the existing `evaluate` wrapper from `eve/ai`. A criteria
string becomes a boolean question; an explicit question returns one assertion
handle; `{ state?, questions }` returns named handles backed by one request.
All calls start immediately and retain existing soft scoring, labels, thresholds,
and gates. The default state is the latest settled turn's `{ input, output }`;
`on` replaces output for individual questions and batch `state` replaces the whole
state. Inputs are captured when the assertions are recorded.

Boolean probabilities become scores directly. Ordered rubric positions divide
by the maximum level index. Choice questions require an expected option and
score selected-option equality as 0 or 1; the expectation is never sent to the
model. Batches share one state, preserve question order, and fail together if
SDK validation or the provider fails.

`judge.model` accepts an evaluation model ID or instance and defaults to the
shared evaluator, currently `typesafe-ai/jev`. Per-call settings override the
resolved eval/project configuration. Provider options retain their existing
`modelOptions.providerOptions` shape. AI SDK owns adapters, authentication,
validation, and retries. The eval signal cancels provider I/O and bounds how long
the runner waits during assertion finalization.

The implementation reuses the assertion collector, diagnostics, verdicts, and
reporters. Metadata records raw answers and normalized scores; batch token usage
is explicitly shared. Evaluation does not promise prose rationales.

Remove autoevals, its adapter, and its public namespace. Migrate criteria judges
to the callable form and use explicit state/questions for specialized rubrics.
Preserve deterministic similarity with the same normalized UTF-16 Levenshtein
score. Braintrust reporting is independent and remains available. Fixture judges
no longer inherit the agent model matrix. This is a breaking public API change.

See [Judge](../docs/evals/judge.mdx) for authoring examples and migration guidance.
