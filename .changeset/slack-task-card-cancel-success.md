---
"eve": patch
---

The Slack task card no longer shows a cancelled task as an error. A task the model stops with `task_cancel` now gets a success check and the line `Stopped early since it was no longer needed` instead of `Stopped`, and the plan title no longer counts stopped tasks.
