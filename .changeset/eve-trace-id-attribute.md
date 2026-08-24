---
"eve": patch
---

Workflow runs for session, subagent, and turn rows now carry a `$eve.trace_id` attribute pointing at the `agent.session` span's trace id, letting dashboards correlate a run with its OTEL trace. The trace id is read from the pre-allocated trace seed in the serialized context at run creation time. Attribute absence means no exported OTEL trace exists.
