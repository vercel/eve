---
"eve": patch
---

Preserve a cancelled task's notification to its parent when shutdown exceeds the cooperative grace period. Parents no longer wait for a notification from a task that was already cancelled.
