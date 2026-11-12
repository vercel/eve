---
"eve": patch
---

When a finished `bash` command's output is truncated, the result again keeps the start of a very long last line and the lines before it.

The truncation note again gives the whole output's line count (`showing last N of M lines`), and memory stays bounded however much the command prints.

Thanks @zackleman for reporting this in #5925 and for the implementation plan this fix follows.
