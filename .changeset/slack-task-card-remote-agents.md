---
"eve": patch
---

`task.agent.work()` in a Slack `taskCard` now also covers remote subagents: eve reads the remote agent's session from its own deployment, with the same credentials it calls the agent with. A dynamic remote agent without `auth` or `headers` no longer fails when its session's stream is read through the parent's stream route.
