---
"eve": patch
---

A session that fails ends the turn it held `cancelled` instead of `failed`: the session failed, not the turn. The error is on `session.ended`, and `failure(view, turnId)` still reads it for that turn. Built-in channels post one notice for the failure, not a turn notice and then a session notice, and an ACP prompt or the web template reports the session's error. Interactions a session withdraws, or settles with an answer, have their other open answers withdrawn by the writer, with the interaction's reason.
