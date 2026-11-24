---
"eve": patch
---

eve's session hosts now take the names of their users: the program's host, runSession()'s host, and the host of storeDurable().run(), and only runSession()'s host keeps session records.
