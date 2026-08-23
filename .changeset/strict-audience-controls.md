---
"eve": minor
---

Channel audience is now resolved into delivery-scoped trace and content controls before the harness runs. `tracePolicy` returns an explicit drop or record decision with input/output controls, and audience is no longer exposed through harness lifecycle events or span export policy context.
