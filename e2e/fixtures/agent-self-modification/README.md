# Self-modification e2e fixture

This fixture exercises the complete local self-modification loop: the root agent decides whether to delegate a persistent change, a fixed self-modification agent edits `/source`, and a later turn uses the rebuilt agent.

The root agent follows the fixture model matrix while the self-modification agent stays pinned to `anthropic/claude-sonnet-5`. This isolates routing differences between root models from source-authoring differences in the child. The routing eval spans the full matrix. The slower tool-authoring eval runs once with the default root model. Required e2e models remain blocking; additional models shared with the authoring benchmarks run as optional matrix legs while the coverage matures.

Self-modification evals use `evals/self-modification/harness.ts` to reset changed source, follow the background child, rebuild runtime artifacts, and clean up after the case.
