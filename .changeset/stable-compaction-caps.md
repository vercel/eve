---
"eve": patch
---

Compaction no longer re-caps a tool result it already capped. Earlier, each later compaction nested another truncation notice into the same result and kept less of its original content.
