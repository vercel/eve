---
"eve": patch
---

Add an experimental `maxModelCallsPerWorkflowStep` agent option for batching sequential model and inline tool cycles into fewer Workflow checkpoints. Raising it above one reduces checkpoint overhead while widening the retry and replay unit.
