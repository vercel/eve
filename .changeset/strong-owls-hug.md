---
"eve": patch
---

fix(evals): coalesce null output for Braintrust reporter and guard against log() throws (#1405)

A no-turn eval (e.g. schedule-dispatch + DB assertions) legitimately produces `result.output === null` per the eval API's own derivation. The Braintrust SDK rejects null/undefined output (`"output must be specified"`), and the throw escaped `onEvalComplete`, killing the entire `eve eval` run — remaining evals never executed and no artifacts were written.

Two fixes:
1. Coalesce `output: result.result.output ?? ""` so null is sent as an empty string.
2. Wrap `experiment.log()` in try/catch so any reporter throw is logged but does not abort the run.
