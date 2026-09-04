---
"eve": patch
---

Move Upstash AgentKit to the memory-provider registry. Run `eve add memory/upstash-agentkit` to install `@upstash/agentkit-eve` and create a principal-scoped slot backed by `redisMemory()`; the previous `extension/upstash-agentkit` registry item is removed.
