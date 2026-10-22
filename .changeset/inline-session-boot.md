---
"eve": patch
---

New sessions start their first model step sooner, and later turns no longer wait for their cancellation hooks to register before their first step. Thanks @Lukavyi for reporting the startup latency in #876.
