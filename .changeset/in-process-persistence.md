---
"eve": patch
---

Sessions run in process are kept as runs on a Workflow World as they run, internally, and continue in another process on the same World, including a turn a crash cut off.

Stream lines are kept in batches, and each step is saved as a change from the step before; sessions on Workflow behave as before.
