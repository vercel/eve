---
"eve": patch
---

Workflow tools can use the same requester-scoped `ctx.getToken` and `ctx.requireAuth` as ordinary tools inside step helpers. Connections, tools, and workflow steps share authorization handling; workflow sign-in waits without holding compute and retries the interrupted step after the callback, including for background tasks.
