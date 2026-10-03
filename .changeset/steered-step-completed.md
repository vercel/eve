---
"eve": patch
---

A step interrupted by a steering message now ends with `step.completed` (`finishReason: "other"`, with any usage the provider reported) before the next step starts, instead of leaving its `step.started` open.
