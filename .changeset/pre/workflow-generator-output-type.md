---
"eve": patch
---

`defineWorkflowTool` now types the output that `endsTurn` and `toModelOutput` receive the way eve produces it.

A generator body's output includes its return value, not only its yields. A tool with an `outputSchema` gets that schema's output, as the definition `defineWorkflowTool` returns already does.
