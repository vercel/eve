---
"eve": patch
---

Tools can start or reach sessions on the agent's channels with `ctx.to(channel, target).send(message, options)`, the same call route handlers and schedules use, such as forking a conversation into a new Slack thread. Ordinary tools call it directly, and workflow tools call it in a `"use step"` helper. Pass `idempotencyKey: ctx.callId` so a retried call reaches the same session once. `ctx.to()` throws in a subagent, a root copy, or a remote agent call. Tools also get `ctx.channel`, the calling session's channel `kind`, `continuationToken`, and `metadata`, as hooks and dynamic resolvers read it.
