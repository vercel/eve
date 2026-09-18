---
"eve": minor
---

Replace `t.judge.autoevals.*` with `t.judge(...)`, supporting criteria, typed questions, and batches through evaluation models with a default of `typesafe-ai/jev`. Configure provider evaluation model instances instead of language model instances; autoevals is removed while deterministic similarity and Braintrust reporting remain available.
