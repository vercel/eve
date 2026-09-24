---
"eve": patch
---

A delegated agent call now fails with `TIMED_OUT` after 2 hours of active time; time the agent spends waiting on a question or approval does not count. When a call times out or is cancelled, a local child that has not stopped within 30 seconds has its session terminated, so its `agentId` can no longer be continued. An `input.requested` event for a workflow tool call's question or approval now carries the call's `taskId`.
