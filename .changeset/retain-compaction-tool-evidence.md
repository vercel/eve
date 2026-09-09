---
"eve": patch
---

Compaction now includes recent tool exchanges in its summary input before evicting them, preserving completion evidence that could previously be dropped. Filtered summaries are rejected even when they contain text, and errors retain bounded provider stop codes for diagnosis.
