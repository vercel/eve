---
"eve": patch
---

`eve eval` now prints a clear, actionable message when it finds no evals but detects `*.eval.ts` files placed inside `agent/`. Instead of the generic "No evals found", it names the offending directories and reminds you that eval files belong in the top-level `evals/` directory (a sibling of `agent/`).
