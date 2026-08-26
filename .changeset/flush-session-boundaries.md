---
"eve": patch
---

Close live session stream responses after each session boundary so buffering proxies flush the final event without delaying web clients.
