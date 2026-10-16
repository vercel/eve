---
"eve": minor
---

`defineDynamic` handlers retain their keys but receive v27 facts: `session.started` and `turn.started` receive those facts, and `step.started` receives `model.requested` instead of the previous `sequence`, `stepIndex`, and `modelId` payload. Dynamic skill, tool, and model resolvers now reject handlers for events their slots cannot receive at build time.
