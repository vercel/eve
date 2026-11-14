---
"eve": patch
---

Speed up long local stream reads by reusing chunk listings briefly and seeking directly to pagination cursors instead of reopening earlier chunks.
