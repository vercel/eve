---
"eve": patch
---

`web_fetch` and session callbacks now refuse a request when the runtime cannot guard it against private and internal addresses, instead of sending it without the guard.

On Node, requests are guarded as before.
