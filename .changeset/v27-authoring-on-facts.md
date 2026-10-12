---
"eve": minor
---

Authored channels and dynamic resolvers read v27 session facts.

- **Channel handlers take `(event, ctx)`.** `event` is the fact or progress record a hook sees, with `type`, `data`, and `scope`. `ctx.channel` is the channel's own context, as `context()` built it, with `continuation`; `ctx` also carries the session, `position`, and `view`. `ctx.scope` is gone: read `event.scope`. Built-in channels' `events` overrides take the same arguments, and Slack renderers take `(event, ctx, next)`, where `next` accepts a changed event.
- **`defineDynamic` keeps its keys, and each handler receives the fact behind its key.** `session.started` and `turn.started` get those facts. `step.started` gets the turn's `model.requested`, whose `scope` names the turn and the run. The earlier payload's `sequence`, `stepIndex`, and `modelId` are gone; `event` stays typed `unknown`.
