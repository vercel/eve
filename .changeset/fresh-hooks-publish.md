---
"eve": patch
---

Separate subagent event publication from hook execution and model preparation. Subagent hooks retain parent session and sandbox access, and hook retries reuse the published event without emitting it again.
