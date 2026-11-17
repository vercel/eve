---
"eve": minor
---

Any dynamic value can require the caller's sign-in through `ctx.getToken(provider)` and `ctx.requireAuth(provider)`, so the agent's dynamic `model` can run each model call on the caller's own credential.
