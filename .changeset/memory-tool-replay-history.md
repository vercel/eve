---
"eve": patch
---

Memory provider tools now survive a mid-turn restart when the turn's history holds non-JSON tool results, such as dates. eve no longer snapshots history into each tool's replay state, so a replayed `tools()` call receives empty `messages`.
