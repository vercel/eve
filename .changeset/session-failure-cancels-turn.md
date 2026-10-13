---
"eve": patch
---

A session that fails now ends the turn it held `cancelled` instead of `failed`, with the error on `session.ended`, and `failure(view, turnId)` still reads it for that turn. Built-in channels post one notice for the failure instead of two, and an ACP prompt or the web template reports the session's error.
