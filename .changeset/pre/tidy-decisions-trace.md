---
"eve": patch
"@vercel/agent-runs": minor
---

Add `decision <model>` OpenTelemetry spans for `decide`, automatic model selection, and tool approvals, with policy-aware model, usage, cost, and failure metadata that distinguishes refusals from request failures.

A decision sits under the operation it runs in, or under the turn when model routing runs before the turn's first step. `@vercel/agent-runs` adds `AgentRun.decision` and an optional `AgentTelemetry.activeSpan`, so a decision nests under a host span inside its operation but not under a host span from another trace, such as a workflow step.
