---
"eve": patch
---

Replace polling during subagent and task startup, session reset, and task cancellation with workflow ownership acknowledgements and streamed lifecycle signals. Reset completion requires a session started on this version; older pinned sessions can time out waiting for the new cleanup signal.
