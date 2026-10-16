---
"eve": patch
---

`eve dev` validates each session line against the event contract before writing it, with an 8 MiB limit per line. Set `EVE_CHECK_SESSION_EVENTS=0` to disable validation or `=1` to enable it outside development.
