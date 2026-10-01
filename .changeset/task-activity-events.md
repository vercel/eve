---
"eve": patch
---

A task's agent now reports each tool call it starts or settles on the parent stream as `task.activity`, for local and remote agents. Slack task cards show the agent's newest tool call on a working task's row, and `taskCard` renderers receive the agent's recent calls as each task's `activity.calls`.
