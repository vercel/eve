---
"eve": patch
---

`eve eval` can now replace what an agent's tools return: put a `defineToolStubs()` set in `evals/stubs/` and pass `{ stubs: "<name>" }` to `t.send` or `t.session`. The model still sees the real tools and their approvals, and a call to a tool the set does not stub fails the turn.
