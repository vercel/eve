---
"eve": patch
---

Deliver concurrent `ctx.agent` messages to one session in the order they were sent. A turn's reply settles the messages sent before the one it answers; when concurrent deliveries reached the agent out of order, a sent message could miss its reply, leaving an agent tool call running indefinitely. Each queued message keeps the auth and call it was sent with.
