---
"eve": patch
---

`connection_search` results no longer include tool input and output schemas. Discovered tools are still registered with their full schemas on the next step, so the model can call them as before, and later requests no longer carry a second copy of each schema in history.
