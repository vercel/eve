---
"eve": minor
---

`bash` waits 60 seconds by default before it leaves a command running in the background, and a truncated `stdout` or `stderr` now names a file in the sandbox that holds its full output.

`write_file` can also overwrite a file the session read and then changed with `edit_file`, without another `read_file` call.
