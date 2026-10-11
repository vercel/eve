---
"eve": patch
---

A model stream that stops sending output without closing no longer holds the turn forever. After 10 minutes without output eve abandons the stream and retries the model call, and the turn fails normally once retries run out. Time spent running tools does not count toward the timeout. eve now requires `ai` 7.0.137 or later.
