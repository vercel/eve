---
"eve": patch
---

Context compaction now keeps the instructions of each loaded skill verbatim instead of summarizing or truncating them. A later load of the same skill replaces the earlier one, and failed loads are ignored. When the active skills alone exceed the compaction budget, the turn fails with `ACTIVE_SKILL_CONTEXT_OVERFLOW` and history is left unchanged.
