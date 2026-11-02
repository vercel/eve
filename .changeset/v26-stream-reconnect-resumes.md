---
"eve": patch
---

Reconnecting to a followed session that started before eve 0.84 now reads only the lines the client has not seen, instead of re-reading and converting the whole history on every stream lease.

A reconnect resumes where the same server instance's last read of that session ended. A reconnect that lands on another instance still reads the history once from the start.

Thanks @typeofweb for reporting this in #5782.
