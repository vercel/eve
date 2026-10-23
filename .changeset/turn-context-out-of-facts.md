---
"eve": patch
---

`delivery.admitted` no longer carries the turn's `clientContext`. Turn context, including context an `onMessage` handler supplies, still reaches every model call in its turn but is no longer readable from the session stream.
