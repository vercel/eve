---
"eve": minor
---

The provided `bash` tool accepts an optional `timeout` in seconds, so the model can wait up to 180 seconds for a build or test suite before the command keeps running in the background.

Calls without `timeout` still wait 30 seconds. Values above 180 wait 180 seconds, and values below 1 wait 1 second. A command still running after the wait returns `status: "running"` as before.
