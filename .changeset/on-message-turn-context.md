---
"eve": patch
---

The eve channel's `onMessage` can now read the request's `clientContext` as `ctx.eve.clientContext` and return its own `clientContext` to replace it for that turn, so the model sees server-checked context without it being kept in session history.
