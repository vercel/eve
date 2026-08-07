---
"eve": patch
---

Add experimental background tasks for local and remote subagents. With `experimental.tasks` enabled, subagent calls return durable task receipts; parents can inspect, continue, or cancel work while lifecycle notifications and human-input requests arrive asynchronously.
