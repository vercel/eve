---
"eve": patch
---

Concurrent channel sends to the same continuation token now forward duplicate initial deliveries to the session that already owns the token. This prevents accepted work from failing admission with a hook conflict while the first delivery is still creating the session.
