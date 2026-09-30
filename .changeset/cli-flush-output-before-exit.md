---
"eve": patch
---

The `eve` CLI now finishes writing stdout and stderr before it exits. A parent process that reads large output through a pipe, such as `eve info --json` for an agent with many tool schemas, now receives the complete output instead of output cut off partway through.
