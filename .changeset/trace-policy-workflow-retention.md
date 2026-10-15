---
"eve": minor
---

Dropped traces and policies excluding either content direction now request Workflow data deletion when the run ends; set `experimental.workflow.retention: "default"` to retain completed transcripts independently of tracing. Expired session-history reads return `410 session_expired` before streaming, including when the World retains purged chunk records.
