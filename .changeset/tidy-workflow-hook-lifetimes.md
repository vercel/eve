---
"eve": patch
---

Activity collectors now finish on expiry even when a hook read is pending. Task and activity workflows rely on workflow completion to clean up their hooks, and subagent calls skip conflict checks for generated reply tokens.
