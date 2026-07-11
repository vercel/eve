---
"eve": minor
---

feat(eve): stamp schedule-dispatched sessions with a `$eve.schedule` workflow attribute

Sessions started by a schedule dispatch now carry `$eve.schedule` (the authored schedule's name) in their workflow run attributes — including sessions a handler starts through `args.receive(...)`, which keep the target channel's kind in `$eve.trigger`. Observability tooling can attribute runs to a specific schedule instead of relying on trigger heuristics.
