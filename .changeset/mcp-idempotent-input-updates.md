---
"eve": patch
---

MCP `agent_update` now acknowledges a repeated answer that eve already accepted for the same input batch instead of returning a conflict, so a client that retries after a lost response converges on the current invocation state. `agent_get` also stops reporting `input_required` as soon as the answer is resolved rather than waiting for the next turn event.
