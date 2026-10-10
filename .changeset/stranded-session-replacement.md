---
"eve": patch
---

A session that replaces a retired stranded session names the session it replaced in `ctx.session.predecessor` (also on dynamic resolver contexts) and `session.started` `data.predecessor` (`{ sessionId }`). The new `transcriptReducer()` in `eve/client` folds a session's stream into its user and completed assistant text since the last clear; combine it with `sessions.attach(predecessor.sessionId).stream()` from `eve/server` in a `session.started` user-role dynamic instruction to give the replacement the earlier conversation.
