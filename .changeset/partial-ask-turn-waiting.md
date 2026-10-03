---
"eve": patch
---

Answering only some of the `ctx.ask()` questions an open turn waits on now parks the turn again with `turn.waiting` on `"input"`, as a partial answer to its tool approvals already does. Before, the session emitted only `input.resolved`, so a reader that stops at `turn.waiting`, such as the client after `respond()`, kept reading until the last question was answered.
