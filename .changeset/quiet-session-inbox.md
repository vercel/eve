---
"eve": patch
---

Reduce session startup overhead by sharing one inbox across messages, authorization callbacks, and workflow-tool replies. Continuation delivery now resumes the workflow before resolving the returned session ID, and ID-addressed delivery skips hook metadata hydration.
