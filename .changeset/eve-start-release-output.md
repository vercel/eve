---
"eve": patch
---

`eve start` no longer keeps the server's stdout and stderr in memory after startup. Output is still forwarded, and an unexpected exit no longer repeats the full log history in its error.
