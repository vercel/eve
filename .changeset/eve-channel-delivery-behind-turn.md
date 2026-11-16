---
"eve": patch
---

A turn no longer waits for channel event handlers, such as Slack's status updates, before calling the model.

Handlers still run in order behind the turn's publications, and a step waits for them before it saves the channel's state. Hooks and stream readers no longer wait for a publication's handlers, so a handler should read the session from its event's `ctx.view` snapshot.
