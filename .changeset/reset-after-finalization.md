---
"eve": patch
---

A session reset now returns only after the old session has finished finalizing, so a send right after the reset reports `session_not_active` instead of `session_not_ready`.
