---
"eve": patch
---

Offer `eve__task_wait` and `eve__task_cancel` from the first step whenever a session has the built-in `bash` tool so promoting a long-running command never mutates the tool list or busts the prompt cache mid-session.
