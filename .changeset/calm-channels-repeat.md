---
"eve": patch
---

Channels can pass an optional `idempotencyKey` to `from(address).send()` so durable sessions suppress retried deliveries. Slack now uses each verified Events API `event_id` automatically.
