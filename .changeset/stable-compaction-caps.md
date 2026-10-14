---
"eve": patch
---

Compaction no longer re-caps a tool result it already capped. A capped result now fits the size limit it was measured against, so later compactions leave it as it is instead of nesting another truncation notice and keeping less of the original content. A summary written after a cap also sees the whole content the capped result kept.
