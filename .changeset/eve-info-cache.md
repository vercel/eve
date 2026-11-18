---
"eve": minor
---

`eve info` reuses its last successful compile when nothing it depends on has changed, so a repeat run takes about 0.2 seconds at any agent size, and `eve info --fresh` forces a recompile.

Compiles are also about a third faster on large agents, because authored modules are bundled into one file instead of one file per module. This speeds up `eve info --fresh`, `eve build`, and `eve dev` too.
