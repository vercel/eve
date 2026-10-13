---
"eve": minor
---

`defineDynamic` handlers keep their keys and now receive the v27 fact behind each one: `session.started` and `turn.started` get those facts, and `step.started` gets the run's `model.requested`. The earlier payload's `sequence`, `stepIndex`, and `modelId` are gone.
