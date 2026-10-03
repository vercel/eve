---
"eve": patch
---

Compaction now estimates tokens from UTF-8 bytes instead of string length, so Chinese, Japanese, Korean, and other non-Latin text no longer counts at a fraction of its real cost. A large tool result in those scripts now triggers compaction before the request overflows the context window.
