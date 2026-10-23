---
"eve": patch
---

Evals keep an input request pending after a `respond()` that answers only some of the open requests. `session.pendingInputRequests` still lists the unanswered ones, and `parked()` holds (and `succeeded()` fails) while the run waits on them. Thanks @elrumordelaluz for reporting this in #5157.
