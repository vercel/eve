---
"eve": patch
---

A step interrupted by a steering message now ends with `step.completed` (`finishReason: "steered"`, `steeredBy` set to the steering message's delivery id, and any usage the provider reported) before the next step starts, instead of leaving its `step.started` open. A steer that arrives while a step's own `step.completed` is publishing no longer closes that step twice.
