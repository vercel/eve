---
"eve": major
---

The agent's dynamic `model` can require the caller's sign-in before a model call through `ctx.getToken(provider)` and `ctx.requireAuth(provider)`.

Breaking: `DynamicContext` no longer extends `DynamicModelContext`. Code that builds a dynamic context by hand and passes it to a model function, for example in tests, must add `getToken` and `requireAuth`.
