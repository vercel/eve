---
"eve": patch
---

Slack now posts the model's text for a step whose only tool call is `task_wait`, so people see what the agent is waiting on while the turn waits; a step with any other tool call, or a schedule's turn, keeps that text as the typing status. `defineChannel` event handlers can now subscribe to `step.completed`, which Slack uses to decide once the step's actions are known.
