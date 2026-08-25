---
"eve": patch
---

Keep durable agent sessions on their persisted OpenTelemetry trace instead of rotating after 200 turns. Agent Trace schema version 2 relies on native trace parentage instead of window, root-session, and duplicated parent-lineage attributes.
