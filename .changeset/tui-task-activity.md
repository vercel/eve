---
"eve": patch
---

The `eve dev` terminal UI now shows each task, such as a subagent call, as one line when it starts and one when it finishes, fails, or is stopped, with a panel above the prompt showing what every working task is doing. The transcript no longer jumps or rewrites while tasks work, the model's own `task_wait` and `task_cancel` calls no longer appear in the terminal UI or Slack typing indicators, and tools with a `label` show it instead of their raw arguments.
