---
"eve": minor
---

A dynamic model is now a `model` field. Use `defineDynamic` from `eve/models`, or `auto()`, which decides once per turn. `agent.ts` itself can't be dynamic; a whole subagent can, with `defineDynamic` from `eve`.
