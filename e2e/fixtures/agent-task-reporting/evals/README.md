# Background task reporting

This fixture checks the full-cohort completion barrier with real models. Both
retained evals carry `real-model`, so world suites exclude them. The root agent,
its built-in agent copies, and the declared warehouse worker all resolve the CI
model through `@eve-e2e/config`; the fixture retains its full model matrix.

Alice is preparing an inventory checklist for Bob's warehouse handoff. Each trial
launches exactly three independent warehouse tasks in one root turn, acknowledges
the accepted assignments, and collects the results into one report for Bob.
The test-only tool keeps its `probe` filename, but its model-facing description
presents an inventory lookup without asking the model to arrange approval. Its
`approval: once()` policy requires a runtime approval in each lookup session instead
of delaying execution with a timer or relying on an `ask_question` exchange. The eval
waits for all three approval requests, approves the first, and reads that child's
completed result from its own session stream. The other two requests remain
unapproved during the partial-state checks.

The third child uses the blocking `warehouse_lookup` workflow tool to invoke a
nested `warehouse-worker`. Blocking delegation keeps the outer task open until
the nested lookup returns, rather than completing it with a background launch
acknowledgement. Its approval is answered through the root session. The eval
checks the nested session identity, real model selection, probe call, and completion
before the outer child's result.

`pending-response.eval.ts` retains 20 trials. After the first child completes,
Alice asks an unrelated arithmetic question. The parent must answer before the
last child completes, without consuming any held completion notifications. Server
event timestamps and the unreleased approvals establish the partial-state window.
Only that user answer and one final cohort report may invoke the parent model
after setup.

`consolidated-report.eval.ts` retains eight trials. It requests compaction in the
same gated partial state, then releases the remaining lookups. Whether compaction
produces a checkpoint or declines to summarize, the parent must retain the cohort
and report every result. No ordinary parent model step may run before settlement.
Successful checkpoint production remains a separately recorded soft assertion.

Both drivers submit approval responses without awaiting a parent model turn.
They retain the parent stream cursor from before the releases and inspect every
subsequent boundary, so an intermediate model step fails even if it emits no text.
The final notification must contain every original task ID exactly once, with no
unknown IDs, and the single report must contain all three distinct inventory items.
There are no prompt-ablation variants, inference delays, or mock silence responders.

E2E execution is CI-only. Focused static checking uses
`pnpm --filter agent-task-reporting exec tsc --noEmit`.
