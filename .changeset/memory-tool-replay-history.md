---
"eve": patch
---

Memory provider tools now survive a mid-turn restart when the turn's history holds non-JSON tool results, such as dates. eve no longer snapshots history into each tool's replay state; a replayed `tools()` call receives the same `messages` the current process resolved the turn's tools with.
