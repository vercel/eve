---
"eve": patch
---

`limits.sessionTimeoutMs` is now an idle timeout: the window restarts each time a turn settles, so a session in active use no longer ends 30 days after it was created. Idle sessions still complete when the window elapses, and the next channel message at their address starts a fresh session as before.
