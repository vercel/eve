---
"eve": patch
---

Restore memory-provider capture after a completed turn. `turn.completed` had stopped carrying the settled history since 0.51.0, so `capture["turn.completed"]` was silently skipped and only compaction-time capture ran.
