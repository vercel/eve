---
"eve": minor
---

`eve info` reuses its last successful compile when nothing it depends on has changed, so a repeat run takes about 0.3 seconds at any agent size, and `eve info --fresh` forces a recompile.
