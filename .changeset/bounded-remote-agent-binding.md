---
"eve": patch
---

Stop reading the parent session's event stream once the remote subagent stream route finds the child's `agent.started` binding. Opening a remote subagent stream no longer replays the rest of a long parent session on every request and retry.
