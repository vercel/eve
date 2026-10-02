---
"eve": patch
---

Eval sessions now have `session.compact()`, which compacts the session between turns and resolves to the compaction events through `session.waiting`, so evals no longer need raw `fetch` calls to cover compaction.
