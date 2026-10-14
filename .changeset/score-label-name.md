---
"eve": patch
---

A labeled `t.score(...)` now uses its label as its name, so `t.score(x).label("grounding")` reports as `grounding` instead of `score [grounding]`, and Datadog and Braintrust log it under `grounding` instead of `score_grounding` or `score [grounding]`.
