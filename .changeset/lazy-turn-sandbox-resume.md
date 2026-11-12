---
"eve": patch
---

Turns no longer resume a session's sandbox in the background when they start, so a turn that never uses the sandbox no longer wakes it; the first tool or file operation that needs it resumes it instead.
