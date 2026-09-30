---
"eve": minor
---

The Chat SDK bridge's `send` now takes a message plus channel send options, and a new `respond(inputResponses, { thread })` answers pending input requests. To migrate, replace `send({ message, context }, { thread })` with `send(message, { context, thread })`, and replace `send({ inputResponses }, { thread })` with `respond(inputResponses, { thread })`. Channel send options also accept `outputSchema`, as `Session.send()` does.

Telegram and Chat SDK inbound messages now go through the public channel `send()`, so route wrappers see them. A Telegram reply to a bot message that no session owns now starts a session instead of failing delivery.
