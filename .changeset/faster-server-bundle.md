---
"eve": patch
---

Bundle the server faster in `eve build` and `eve dev` by resolving dependency imports and CommonJS path globals inside Rolldown instead of eve's JavaScript plugin hooks.

`eve build` also no longer repeats the authored module builds after sandbox prewarm.
