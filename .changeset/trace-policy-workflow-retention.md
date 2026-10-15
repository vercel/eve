---
"eve": minor
---

Derive Workflow run-data retention from the session's trace policy: dropped traces or policies excluding either content direction now request deletion when the run ends, making completed transcripts unreadable on supporting Worlds. Set `experimental.workflow.retention: "default"` to retain completed-session data independently of tracing, or `0` to always request deletion.
