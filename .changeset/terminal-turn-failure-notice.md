---
"eve": patch
---

When a failed turn ends the session, built-in channels now post one notice telling the user to start a new session, instead of also posting a "please try again" notice for the same error. `turn.failed` events now carry `terminal: true` when `session.failed` follows, so custom channel handlers can make the same choice without tracking state.
