---
"eve": patch
---

Channel activity, such as Slack, now shows each agent task or `ctx.agent` session as its own row under the call that opened it. The row settles as completed, failed, or cancelled when the agent's first turn ends, and any turn cancelled while it waits for an answer, including the caller's own, now settles as cancelled instead of staying running. Before, a local agent's activity merged into the caller's row and marked it done early, a remote agent's row stayed running until the caller's turn ended, and continuing a remote agent task by `taskId` failed while activity was on. Later turns of a task continued by `taskId` still appear under its first row.
