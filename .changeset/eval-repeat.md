---
"eve": patch
---

`eve eval --repeat <n>` and the `repeat` option in `evals.config.ts` run every eval `n` times to measure repeatability. Each attempt is reported as its own result with a 1-based `attempt`, with its own artifact files, Braintrust row, JUnit test case, and Datadog run iteration, and the console summary shows a per-eval pass rate such as `3/5 passed`.
