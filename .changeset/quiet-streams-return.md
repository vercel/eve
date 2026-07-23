---
"eve": patch
---

Allow `session.send()` and `session.stream()` callers to disable automatic stream reconnection with `streamReconnectPolicy: { reconnect: false }`, so relays and proxies can own cursor recovery and retry policy.
