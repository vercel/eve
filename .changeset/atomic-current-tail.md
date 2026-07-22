---
"eve": patch
---

Add `throughCurrentTail` to `ClientSession.stream()` for one atomic finite replay captured and closed by the eve stream route. Finite replays commit session state only after clean completion, preserving the prior cursor on interrupted bodies instead of reconnecting into a different snapshot.
