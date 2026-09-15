---
"eve": minor
---

Replace `continuation.rekey()` with `continuation.alias()`. Every claimed address stays active and accepts messages through the session's merged inbox, and the most recently selected alias is exposed as `continuation.token`.
