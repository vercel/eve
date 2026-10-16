---
"eve": patch
---

A turn step no longer chooses whether the turn waits on a person, on calls, or on tasks. The session now decides that from the state the step leaves, using one function that a Lean model in `formal/` proves things about. Sessions behave as before.
