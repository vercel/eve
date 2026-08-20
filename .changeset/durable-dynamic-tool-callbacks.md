---
"eve": patch
---

Make dynamic tool approval, execution, and output callbacks durable across cold starts. Non-serializable callback captures now fail with an actionable error instead of losing values during replay.
