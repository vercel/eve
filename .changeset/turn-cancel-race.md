---
"eve": patch
---

A turn cancellation observed while a durable turn step is returning now settles the turn as cancelled instead of losing the race to an ordinary completion. Previously the step could miss the abort signal and finish `done`, leaving the session in a completed state after the user had already cancelled. The cancel signal also now aborts in the same microtask that consumes the cancel payload, so a cancel replayed alongside a completed step can no longer lose the settle check by one task-queue hop.
