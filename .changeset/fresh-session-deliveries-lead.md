---
"eve": patch
---

Deliveries received on the current session hook now run before older deliveries captured from a replaced hook. This prevents a re-opened session request from being preceded by stale buffered input from a dropped connection.
