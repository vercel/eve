---
"eve": patch
---

eve now decides the history each model call reads in one place, before every model call and for `session.compact()`.

Compaction is unchanged: eve summarizes past `agent.ts`'s threshold or when `session.compact()` asks.
