---
"eve": patch
---

eve's turn step now passes the process app into the turn's context, so the runtime identity, model attribution headers, and connection principals read the app they were given; behavior is unchanged.
