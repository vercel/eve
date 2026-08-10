---
"eve": minor
---

Channel message sends now use `turnPolicy: "steer"` by default, so accepted messages replace active turns through cancellation-backed steering without a separate cancel request. Set `turnPolicy: "queue"` on a channel or individual send to preserve the previous wait-for-completion behavior.
