---
"eve": patch
---

Workflow tools can resolve requester-scoped credentials with `ctx.getToken` and `ctx.requireAuth` inside step helpers. When sign-in is needed, the workflow waits without holding compute and retries the interrupted step after the callback, including for background tasks.
