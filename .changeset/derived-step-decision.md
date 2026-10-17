---
"eve": minor
---

`waiting(view, turnId)` now returns `{ on: "session" }` while the session works on a turn, and `undefined` only when no open turn has the id; a wait on work names its `tasks`. The call and task form is now `blockedBy(view, { callId })` or `blockedBy(view, { taskId })`, which returns the interactions their work waits on.

The session now decides from its own state whether a turn runs again or waits, and admits every delivery it holds before it waits, so `queue(view)` lists messages queued behind a turn. A turn no longer spins when the person steered past approvals and the model asked for new ones, a refused answer no longer fails the session, a failed compaction ends its change once, and a cancel that arrives as its turn ends settles `ignored`. An answer the session forwarded to the session that asked no longer counts as waiting on a person, and `requestStatus` reads a delivery outcome a newer writer adds as `failed`.
