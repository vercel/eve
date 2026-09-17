---
"eve": patch
---

Add A2A 1.0 support: delegate to external agents with `defineA2AAgent`, or publish an agent with `a2aChannel`. Both use durable tasks with authentication, input continuation, polling, and cancellation; the channel also provides Agent Card discovery, task listing, and SSE updates.
