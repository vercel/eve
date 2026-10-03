---
"eve": patch
---

Fix Docker sandbox template pruning so `eve dev` removes stale template images again, and drop the intermediate `eve-sandbox-dockerfile` image once its template is committed.
