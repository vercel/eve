---
"eve": patch
---

The built-in `bash`, `write_file`, and `connection_search` tools now give the model clearer usage guidance, and `write_file` results include the written file's line count. `connection_search` accepts a `limit` from 1 to 20, so one search can no longer surface an unbounded number of tools.
