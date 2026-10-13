---
"eve": patch
---

Under `eve dev`, each line a session writes is checked against the event contract, and a violation fails the write. Set `EVE_CHECK_SESSION_EVENTS=0` to turn the check off, or `=1` to turn it on elsewhere. A line is at most 8 MiB.
