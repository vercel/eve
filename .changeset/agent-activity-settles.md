---
"eve": patch
---

An agent task or `ctx.agent` session now shows as its own row in channel activity, such as Slack, and the row settles as completed, failed, or cancelled when the agent's turn ends. Before, a local agent's activity merged into the caller's row and marked it done when the agent finished, a remote agent's row showed running until the caller's turn ended, and continuing a remote agent task by `taskId` failed while activity was on.
