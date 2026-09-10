---
"eve": patch
---

Compaction now supplies the current user request as bounded context when summarizing older tool exchanges, so the recorded actions remain tied to the requested work. Provider-filtered summaries are rejected even when partial text is returned, and summary errors retain bounded provider stop codes for diagnosis.
