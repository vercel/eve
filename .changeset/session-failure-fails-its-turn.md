---
"eve": patch
---

A failure that ends the session, such as a rejected API key, a failed model selection, or a spent session usage limit, now settles its turn `failed` with the error before `session.ended`, instead of settling the turn `cancelled` with no error.

Readers that key on `turn.settled`, such as hooks that report failed turns or per-turn metrics, now see these failures without checking `session.ended`. A cancelled turn again means a person stopped or cleared it, or the session ended some other way. Built-in channels still post one notice: the session's.

Thanks @zackleman for reporting this and proposing the fix in #5916.
