---
"eve": patch
---

Labeled assertions now report to Braintrust and Datadog under their label, so `t.score(x).label("grounding")` logs as `grounding` instead of `score [grounding]` or `score_grounding`. Display names in the console and run artifacts are unchanged, and labeled metrics start a new series under the bare label.
