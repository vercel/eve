---
"eve": patch
---

`limits.sessionTimeoutMs` is now an idle timeout: the window restarts each time a turn settles, so a session in active use no longer ends 30 days after it was created. When an idle session does expire, the next channel message at its address starts a fresh session whose `ctx.session.predecessor` names the expired one, so your instructions can carry the earlier conversation forward.
