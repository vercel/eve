---
"eve": patch
---

Background workflow tools now use one durable run for execution and task lifecycle. Subagent receipts include `agentId`, and workflow `agent()` calls require a replay-stable `key`.
