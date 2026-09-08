---
"eve": patch
---

Add explicit Datadog operation and resource names to framework-owned agent spans while preserving their OpenTelemetry names and trace hierarchy. Agent invocation spans now include `agent.turn.outcome` so completion, failure, and cancellation remain queryable in backends that discard span events.
