---
"eve": patch
---

A step interrupted by a steering message now ends with `step.completed` before the next step starts, instead of leaving its `step.started` open. The event has `finishReason: "steered"` and, when available, `steeredBy` with the delivery id of the steering message. A steer that arrives while a step's own `step.completed` is publishing no longer closes that step twice.
