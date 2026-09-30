---
"eve": patch
---

Events read from a session stream, including over HTTP and through `session.stream()` and `snapshot()`, now carry `meta.index`: the event's absolute zero-based position in the stream, the same number `startIndex` addresses, even when the read starts from a negative `startIndex`. Use it to order stored events instead of counting positions yourself; hooks and channel adapter handlers do not receive it.
