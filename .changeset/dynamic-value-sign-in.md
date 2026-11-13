---
"eve": patch
---

Add `ctx.getToken(provider)` and `ctx.requireAuth(provider)` to dynamic values. A dynamic `model` can resolve the caller's credential before each model call; when the caller must sign in, eve pauses the turn and runs the model call once the caller signs in.
