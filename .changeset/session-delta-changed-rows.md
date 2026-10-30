---
"eve": patch
---

Session steps now return only the session projection rows they changed, instead of every row of each changed table, so a step's stored output no longer grows with the calls and parts the turn already settled.

Thanks @mrud for reporting this in #5635.
