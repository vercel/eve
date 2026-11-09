---
"eve": minor
---

Channel event handlers can call `ctx.channel.continuation.release(token)` to stop a session answering at an address an earlier `alias` added, so another session can claim it.

Payloads the address already accepted stay with the session. A session can't release its current address; alias the new one first. This is the runtime half of moving a live session to a new address, such as a Slack thread's session into a code channel.
