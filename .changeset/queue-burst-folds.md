---
"eve": patch
---

Messages that reach an idle session's inbox together now start one turn when they share a principal.

Before, the first one started its turn alone and the rest waited for it to end, even with `turnPolicy: "queue"` and the same caller.
