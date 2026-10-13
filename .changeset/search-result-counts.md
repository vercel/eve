---
"eve": patch
---

`eve__search` results now include `searched`, the number of entries the query covered, and `remaining`, the number of matches past `limit`, so the model can tell after one search how much is left to find. Its description now tells the model to search only when nothing in its tool list fits the request.
