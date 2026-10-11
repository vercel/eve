---
"eve": patch
---

When a failed turn ends the session, built-in channels now post one notice telling the person to start over, instead of a "please try again" notice followed by a "start a new session" notice for the same error. `turn.failed` events now carry `terminal: true` when `session.failed` follows (and `false` when the session waits for the next message), so custom channel handlers can make the same choice.
