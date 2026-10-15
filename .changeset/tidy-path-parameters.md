---
"eve": patch
---

Reject OpenAPI path parameter values equal to `.` or `..` before sending requests, so URL normalization cannot change the intended route. This validation also applies to application-provided arguments.
