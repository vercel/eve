---
"eve": patch
"@vercel/agent-runs": minor
---

Name the memory store on memory provider tool calls, so a trace query by `gen_ai.memory.store.id` finds a scope's tool reads and writes as well as its recall and capture.

The `execute_tool` span of a memory provider tool, such as `profile__save`, now carries `gen_ai.memory.store.id` and `agent.memory.slot`, matching the `search_memory` and `upsert_memory` spans of the same slot. The store ID is the slot's opaque scope key, so it is recorded whatever the trace policy captures. `@vercel/agent-runs` adds an optional `memory` lifecycle to `ActiveOperation` on tool operations to record it.
