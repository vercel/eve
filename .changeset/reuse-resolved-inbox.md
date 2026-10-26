---
"eve": patch
---

Reuse resolved inbox routing information between client turns to avoid a hook lookup on each message. Refresh stale routing after a confirmed refusal without retrying uncertain deliveries.
