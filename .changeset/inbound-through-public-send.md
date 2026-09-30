---
"eve": patch
---

Inbound Slack messages now go through the public `from(address).send()`, so a route wrapper that replaces `send` sees every inbound message and receives delivery failures as errors. Channel `send()` also forwards its `state` option to the `deliver` hook as `payload.state` on every delivery, as `respond()` already did.
