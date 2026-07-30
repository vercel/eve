---
"eve": patch
---

A turn cancellation observed while a durable turn step is returning now settles the turn as cancelled instead of losing the race to an ordinary completion. Previously the step could miss the abort signal and finish `done`, leaving the session in a completed state after the user had already cancelled.
