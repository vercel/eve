---
"eve": minor
---

Replace continuation-token HTTP, client, and channel APIs with explicit ID-addressed sessions and consistent channel-local operations. The eve HTTP API now uses only `/eve/v1/session` routes; client and eval `send` methods take `{ message, ... }`; schedules use `send(channel, input)`; and Slack handlers expose flat `ctx.send()`, `ctx.cancel()`, and related operations.
