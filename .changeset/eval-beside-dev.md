---
"eve": patch
---

`eve eval` now runs while an `eve dev` session for the same agent is open, instead of failing with "A dev server is already running for this eve agent." The eval server keeps its runtime generations, local Workflow data, and server record in a per-run directory under `.eve/eval-servers/`, so it never swaps or prunes the dev session's state.
