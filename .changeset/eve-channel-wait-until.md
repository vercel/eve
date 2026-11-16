---
"eve": minor
---

Channel event handlers can pass work the turn doesn't depend on to `ctx.waitUntil(promise)`, and the Slack channel uses it so its status updates no longer delay each model call.

Handlers still block the turn by default. eve waits for `waitUntil` work before each model call ends, before it saves the session, and before a cancelled turn's checkpoint, and logs a rejection instead of failing the turn. A cancelled turn now also keeps the channel state its handlers left.
