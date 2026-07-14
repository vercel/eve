---
"eve": patch
---

Compaction now reserves room for its checkpoint prompt before reaching the configured threshold. The prompt asks the compaction model to distinguish completed work from remaining work, and later compactions receive the previous checkpoint intact instead of truncating it with ordinary transcript text.
