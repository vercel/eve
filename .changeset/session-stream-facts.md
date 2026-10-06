---
"eve": patch
---

The `input.requested` stream event type gains an optional `callId`. On a request relayed from a subagent or workflow tool run, it names the call in the receiving session that the request serves; the request keeps its original turn and step coordinates, and the stream stays on version 26.
