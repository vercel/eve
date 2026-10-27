---
"eve": patch
---

A step interrupted by a steering message now ends with `step.completed` (`finishReason: "steered"` and `steeredBy` (the delivery id of the message that cut it), with any usage the provider reported) before the next step starts, instead of leaving its `step.started` open.
