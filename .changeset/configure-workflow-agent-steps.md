---
"eve": patch
---

Add the experimental `workflow.agentStepsPerWorkflowStep` agent config to batch multiple agent-loop steps within each durable Workflow step. The default remains one; completed logical steps are journaled for retry recovery, while durable waits end a batch early.
