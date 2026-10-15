---
"eve": patch
---

Reject dot segments in OpenAPI path parameters before sending requests, so URL normalization cannot change the intended route. This validation also applies to application-provided arguments.
