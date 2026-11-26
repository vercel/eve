---
"eve": minor
---

Add `scope` to `ScheduleProviderContext` and let `schedules(definition, { auth })` bind a client outside a turn.

- `ScheduleProviderContext.scope` is the authorized scope that `namespace` is derived from, so a provider can partition storage by it.
- Outside a turn, such as in an HTTP channel route handler, `schedules(definition, { auth })` acts as the verified principal you pass, for example the result of `routeAuth`. Passing `auth` inside a turn throws, because a turn's principal never changes.
