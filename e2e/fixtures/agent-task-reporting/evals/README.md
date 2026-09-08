# Background task reporting

This fixture measures whether pending-cohort guidance suppresses a required user
response after an intermediate task wake.

`consolidated-report.eval.ts` retains eight reporting/compaction trials, then runs
20 trials with the pending instruction and 20 without it. Each comparison trial
starts the same three warehouse lookups, observes an intermediate completion,
asks an unrelated arithmetic question, and waits for the combined inventory
report. The comparison trials do not request compaction.

The fixture model strips the trial marker from both variants before inference.
The off variant also removes the current pending-cohort instruction. Task state,
task results, launch guidance, settled guidance, model settings, and the runtime
delivery policy are preserved. Both arms use the same 128,000-token fixture
context budget and assert that no compaction occurred. Unit tests compare the requests and check that
the original history is unchanged. This is a prompt ablation, not a simulation
of cohort settlement or wake coalescing.

Assertions record three outcomes separately:

- Whether intermediate wakes produce user-facing text. This is a gate for the
  on variant and a recorded score with threshold zero for the off control.
- Whether the user receives the arithmetic answer, without tools, before the
  last child turn completes. Server event timestamps establish ordering; seeing
  a reply before the final parent notification alone is insufficient.
- Whether the final parent report includes all inventory results.

A separate timing assertion requires the question to reach its parent turn before the
last child completes. A trial that misses that window cannot establish a prompt
effect. Provider errors, failed delegation, and missing intermediate wakes are
also setup/runtime failures rather than evidence of unwanted silence.

The variants share the same scenario and configured probe delays; stochastic
model decisions and observed completion times can differ. Inspect per-trial
outcomes and timing logs before attributing a difference to the instruction.
Passing this small sample does not establish absence of interference in other
conversations or models.

Run the fixture's `test:unit` script for the request-transformation checks. The
real-model comparison runs in the `agent-task-reporting` model-suite CI jobs.
