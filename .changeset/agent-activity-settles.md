---
"eve": patch
---

Channel activity, such as Slack, now shows each agent task or `ctx.agent` session as its own row under the call that opened it. The row settles as completed, failed, or cancelled when the agent's first turn ends, and a turn cancelled while it waits for an answer, including the caller's own, now settles as cancelled unless its own approval or sign-in can still be answered. Before, a local agent's activity merged into the caller's row and marked it done early, a remote agent's row stayed running until the caller's turn ended, and a later message to a remote agent, such as continuing its task by `taskId`, failed while activity was on. Later turns of the same session, such as a second `send` or a task continued by `taskId`, still appear under its first row.
