---
"eve": patch
---

Channel message sends now use cancellation-backed experimental steering by default, so accepted messages replace active turns without a separate cancel request. Set `turnPolicy: "queue"` on a channel or individual send to preserve the previous wait-for-completion behavior.
