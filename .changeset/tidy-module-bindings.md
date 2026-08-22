---
"eve": patch
---

Record a required physical binding for every runtime-loaded module in the compiled agent graph. Generated and development module maps now load those bindings directly and reject incomplete graphs instead of reconstructing source paths from logical identity.
