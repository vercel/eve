---
"eve": minor
---

Channel audience is now resolved into a delivery decision used to construct harness instrumentation. `tracePolicy` returns an explicit drop or record decision with input/output controls; dropped deliveries suppress AI SDK span production and provider hooks, and audience is no longer exposed through harness lifecycle events or span export policy context.
