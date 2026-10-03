---
"eve": minor
---

The `bash` tool no longer blocks on slow commands: a command still running after 30 seconds keeps running in the sandbox and returns `status: "running"` with its process group `pid`, its output so far, and an `outputDirectory` whose `stdout`, `stderr`, and `exit` files the model reads with later commands. Cancelling a turn now stops a command that has not yet returned. `BashToolOutput` now carries `status`, and `exitCode` is present only on `completed` results, so authored wrappers that read the output should check `status` first.
