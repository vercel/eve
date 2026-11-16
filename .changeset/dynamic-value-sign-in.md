---
"eve": minor
---

The agent's dynamic `model` can require the caller's sign-in before a model call through `ctx.getToken(provider)` and `ctx.requireAuth(provider)`, called before it builds the model.
