---
"eve": patch
---

Emit OpenTelemetry GenAI `invoke_workflow` spans when a `defineWorkflowTool` run coordinates nested agents, using the path-derived tool name as `gen_ai.workflow.name`. Durable workflow tools without agent operations remain ordinary actions.
