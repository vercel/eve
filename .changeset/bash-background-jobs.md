---
"eve": minor
---

The `bash` tool no longer blocks on slow commands: a command still running after 30 seconds keeps running in the sandbox as a job and returns `status: "running"` with a `jobId` and its output so far, and the model checks on or stops it with `eve-job wait` and `eve-job stop`. `BashToolOutput` now carries `status`, and `exitCode` is present only on `completed` results, so authored wrappers that read the output should check `status` first.
