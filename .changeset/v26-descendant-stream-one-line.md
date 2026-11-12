---
"eve": patch
---

Opening a subagent's stream through a parent session that started before eve 1.0 no longer re-reads the parent's whole history on every open and reconnect, which could make long sessions answer 404 `descendant_unavailable`.

eve now verifies the child against only the parent's stored line at the requested position, whichever eve version wrote it.

Thanks @zackleman for reporting this in #5928.
