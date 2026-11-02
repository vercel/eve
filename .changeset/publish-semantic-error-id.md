---
"eve": patch
---

A failed model run, turn, or session now names the failure eve recognized in `error.semanticErrorId`, such as `gateway-rate-limited`, so clients can handle a specific failure without matching its message.

The field is absent when eve doesn't recognize the failure.
