---
"eve": patch
---

Only batch adjacent queued deliveries when their full auth contexts match, preventing one sender's input from running under another sender's auth. Anonymous deliveries stay separate; matching authenticated follow-ups still batch with their attachments and context in order.
