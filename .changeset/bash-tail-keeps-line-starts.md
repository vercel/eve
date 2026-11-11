---
"eve": patch
---

`bash` results for a command that ends with a very long line again keep the start of that line and the lines before it, as `truncateTail` would from the whole output, while memory stays bounded however much the command prints.

The truncation note on a finished command again reads `showing last N of M lines` instead of `earlier output omitted`.

Thanks @zackleman for reporting this in #5925.
