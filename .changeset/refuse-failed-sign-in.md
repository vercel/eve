---
"eve": patch
---

A sign-in that fails with `retryable: false` now stops the turn from starting the same sign-in again. A later tool call in the same turn that needs the same grant for the same principal gets that failure back instead of a new `authorization.required`, and the next turn asks again. `authorization.required` and `authorization.completed` now carry `grant` and the connection principal's identity (no attributes), and a `failed` `authorization.completed` carries `retryable`. A failure without `retryable`, from an older eve, is treated as retryable.
