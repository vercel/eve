---
"eve": patch
---

A session registers one Workflow abort hook per turn instead of two, so a new session reaches its first turn sooner: a turn's cancel and steer now share one controller, and a steer passes the step the controller that replaces it.
