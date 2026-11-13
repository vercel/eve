---
"eve": patch
---

When `eve__task_wait` returns with one task's result while others are still working, the result now tells the model to wait again if its reply needs the rest, so it no longer sends a partial answer first.
