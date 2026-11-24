---
"eve": patch
---

Compaction now learns how dense a session's content is from the growth between two provider-measured calls, and scales its estimate of tokens added since the last count by that density.

A model call whose tokens run denser than eve's `bytes / 4` estimate (JSON, code, tool results) triggers compaction before it passes `compaction.threshold`, instead of passing it by the difference. Fixed provider overhead, such as provider tool prompts, is not treated as density, so small prompts do not compact early.
