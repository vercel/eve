---
"eve": patch
---

Session stream requests now open the event stream while the tail index lookup is in flight, and the event stream reads its durable source only as fast as the client consumes it instead of buffering the whole history in memory.
