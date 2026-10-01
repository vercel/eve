---
"eve": minor
---

The first local subagent turn now uses its caller's trace; remote turns remain separate roots with dispatch links, and later child turns start new traces. Queries that followed local `eve.link.type=agent.dispatch` links must use `parentSpanId` or `agent.parent_run.id` and `agent.parent_call.id`; third-party spans receive the conversation ID only when they do not set one.
