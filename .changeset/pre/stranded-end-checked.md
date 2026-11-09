---
"eve": patch
---

Ending a stranded session now writes the same checked commit as any other session end.
A stranded stream that never recorded `session.started`, such as one an older deployment opened, gets it in the commit that ends the session.
