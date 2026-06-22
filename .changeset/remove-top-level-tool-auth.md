---
"eve": minor
---

Remove the top-level `auth` field from `defineTool()` and require tool auth providers to be passed inline to `ctx.getToken(provider)` or `ctx.requireAuth(provider)`.
