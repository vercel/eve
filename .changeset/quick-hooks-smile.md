---
"eve": patch
---

Reduce new-session startup latency by claiming command hooks while the session initializes. Session creation, stable and authorization readiness, and continuation ownership now complete in parallel before the first turn starts.
