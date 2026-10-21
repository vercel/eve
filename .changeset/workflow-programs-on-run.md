---
"eve": patch
---

Each start or resume of a `workflow` tool program may now run up to 30 seconds of JavaScript and take up to 5 minutes in total, and time spent waiting for child agents counts toward neither limit. A program paused by an earlier eve version cannot resume on this one and fails with `WORKFLOW_PROGRAM_CONTINUATION_UNSUPPORTED`.
