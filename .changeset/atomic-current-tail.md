---
"eve": patch
---

Add `throughCurrentTail` to `ClientSession.stream()` for one atomic finite replay captured and closed by the eve stream route. Finite replays advance the session cursor and reject interrupted bodies instead of reconnecting into a different snapshot.
