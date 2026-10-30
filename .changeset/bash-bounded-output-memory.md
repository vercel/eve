---
"eve": patch
---

The `bash` tool now keeps only the last 50 KiB of each output stream while a command runs, so a verbose command no longer holds its whole stdout and stderr in memory.

Very large output no longer fails with `Cannot create a string longer than 0x1fffffe8 characters`. Output past the limit is noted as `earlier output omitted`, as it already was for commands left running.

Thanks @mrud for reporting this in #5651.
