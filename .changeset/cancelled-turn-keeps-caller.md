---
"eve": patch
---

A follow-up message cancelled before its first model call now keeps its own sender as `ctx.session.auth.current`. Previously the cancelled turn reverted to the previous caller, even when the follow-up was anonymous, so `turn.cancelled` hooks saw the wrong identity.
