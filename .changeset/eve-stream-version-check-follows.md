---
"eve": patch
---

A session stream resumed past its first line opens sooner on a server instance that hasn't served that session yet, because the stream version check no longer looks up the stream's tail first.
