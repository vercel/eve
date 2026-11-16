---
"eve": patch
---

Apply a forwarded trace content ceiling to instrumentation files and to AI SDK telemetry in a remote agent, so a downstream hop records no more prompt or response content than the upstream hop allowed.

Before this change, each instrumentation file's `tracePolicy` was evaluated on its own, and an agent without OpenTelemetry used its audience default. Both paths ignored a forwarded `recordInputs: false` or `recordOutputs: false` ceiling.
