---
"eve": patch
---

Pre-allocated session trace seeds now consult the configured OTel sampler, so `$eve.trace_id` workflow attributes are only stamped for traces the sampler will actually record. Previously an `always_off`, ratio, or custom sampler could leave links to traces that were never exported.
