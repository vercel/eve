---
"eve": patch
---

Reattach durable approval settlements to every delivery result, so a multi-request approval batch answered one response per respond() call resumes the parked turn once its last request settles instead of stranding the session with settled-but-never-executed tool calls.
