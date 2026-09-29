---
"eve": patch
---

Workflow tools can authorize answers to `ctx.ask` with a named response-policy step, using the same allow/reject decisions and responder-bound auth capabilities as tool approvals. Rejected answers leave the question pending, including when a parent agent relays it.
