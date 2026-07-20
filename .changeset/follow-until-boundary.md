---
"eve": minor
---

The client now reconnects durable event streams from their last cursor, so long turns continue across transient connection cuts without replaying events. Stream retries are now managed internally, interrupted sessions remain resumable, and `maxReconnectAttempts` has been removed from `ClientOptions`, `EveAgentStoreInit`, and the React, Svelte, and Vue `UseEveAgentOptions` APIs.
