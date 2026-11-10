---
"eve": patch
---

Compaction now summarizes directly and must bring the input under half the context window on the provider's token count, so a long session compacts once instead of several times in a row.

It no longer caps old tool output first. A compaction whose result is still over the threshold on the next call skips the stage that fell short.
