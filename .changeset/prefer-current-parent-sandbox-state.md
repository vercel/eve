---
"eve": patch
---

Prefer the current owning sandbox state when a resumed child inherits its parent's sandbox, carrying refreshed state through parked `agentId` continuations so replacement cannot reconnect the child to stale state.
