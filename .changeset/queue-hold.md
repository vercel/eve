---
"eve": minor
---

`limits.queueHoldMs` in `defineAgent` makes an idle session wait that many milliseconds after a `turnPolicy: "queue"` message before it starts the turn.

Queued messages that arrive within the wait and share its principal join the turn, and a steering message from the same principal starts it at once.

A message from another principal never joins the held turn and waits for it to end. A cancel, `reset`, `clear` or session timeout ends the wait and applies to the held turn.
