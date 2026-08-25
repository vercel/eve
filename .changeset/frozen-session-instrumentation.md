---
"eve": minor
---

Freeze instrumentation policy when a session is created and route lifecycle events, AI SDK telemetry, propagation, and cancellation through one bound session control surface. Native `agent.*` traces now preserve `tracePolicy` decisions even when the process sampler would make a different choice; destination export policies remain independent.
