---
"eve": patch
---

`eve dev` and the framework hosts now reuse a recorded dev server only when the server answering on its port is the one that wrote the record, because each server stamps the record with a random id.
