---
"eve": minor
---

Replace continuation-token HTTP, client, and channel APIs with explicit ID-addressed sessions and consistent channel-local operations. The eve HTTP API now uses only `/eve/v1/session` routes; client, eval, and fixed-session `send` methods take `{ message, ... }`; schedules use `send(channel, input)`; and Slack handlers expose flat `ctx.send()`, `ctx.cancel()`, and related operations. Channel event handlers read session identity from `ctx.session.id`, while `session.failed` provides `data.sessionId` directly.
