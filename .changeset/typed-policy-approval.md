---
"eve": patch
---

Typing `approve` or `cancel` now answers a tool approval that has an `approval.response` policy. The policy checks the person who typed the reply, just as it checks someone who presses a button. Before, the reply reached the model as an ordinary message and the approval stayed pending.
