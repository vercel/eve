---
"eve": patch
---

Workflow session, subagent, and turn rows now include `$eve.trace_id` when a sampled agent trace is available, allowing workflow views to open the corresponding OpenTelemetry trace directly. Rows without an exported agent trace omit the attribute.
