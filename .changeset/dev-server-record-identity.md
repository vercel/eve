---
"eve": patch
---

`eve dev` now starts when its leftover state record names a port that another eve server holds, because the record carries the server's pid and a random id and is deleted when the server answering on its URL returns a different id.
