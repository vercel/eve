---
"eve": patch
---

Reintroduce the `ExperimentalWorkflow` opt-in marker in `eve/tools`. Re-exporting it from `agent/tools/workflow.ts` enables the `Workflow` orchestration tool, which can spawn the agent's subagents from model-authored JavaScript. Workflow-spawned subagent calls are now capped per program by the new `limits.maxSubagents` agent setting (default 100) — calls beyond the budget resolve with a `WORKFLOW_SUBAGENT_LIMIT_REACHED` error result instead of starting a child session — and the tool stays root-only, so delegated subagent sessions never receive it.
