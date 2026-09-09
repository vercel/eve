---
"eve": minor
---

Reduce workflow startup and checkpoint lookups, reuse stream encryption-key resolution, and move observability work off the execution path. HTTP follow-ups, controls, and callbacks now acknowledge validated requests before background delivery; cancellation and reset responses no longer wait for settlement.
