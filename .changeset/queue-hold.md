---
"eve": minor
---

`limits.queueHoldMs` in `defineAgent` makes an idle session wait that many milliseconds after a `turnPolicy: "queue"` message before it starts the turn.

Queued messages that arrive within the wait and share its principal join the turn, and a steering message starts it at once.
