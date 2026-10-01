---
"eve": patch
---

Channels can now handle `step.started`, which fires before each model call in a turn. The default Slack channel uses it to replace a stale thread status when the model starts another step. The status shows `Reviewing results...` after a task finishes and `Thinking...` after a tool call. Before, `Waiting on 3 tasks...` or a finished tool's label lingered until the model streamed its next output.
