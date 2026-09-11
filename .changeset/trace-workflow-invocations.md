---
"eve": patch
---

Emit OpenTelemetry GenAI `invoke_workflow` spans for `defineWorkflowTool` runs, using the path-derived tool name as `gen_ai.workflow.name` while preserving durable action lifetimes and nested agent-call parenting.
