---
"eve": patch
---

Drop task update and ready notifications after `task_peek` has already exposed the task's ready state, avoiding a redundant model turn. Conditional task delivery also treats results incorporated into an earlier response as having nothing new to report.
