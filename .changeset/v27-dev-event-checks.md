---
"eve": patch
---

`eve dev` now validates session event lines before writing them and rejects lines larger than 8 MiB. Set `EVE_CHECK_SESSION_EVENTS=0` to disable validation or `=1` to enable it outside development.
