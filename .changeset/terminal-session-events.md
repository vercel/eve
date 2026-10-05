---
"eve": patch
---

Fix channel `session.completed` handlers throwing when a session expires, resets, or closes between turns. The handler's `ctx.session.turn` reports the session's last turn.
