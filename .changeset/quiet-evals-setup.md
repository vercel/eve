---
"eve": patch
---

Add eval setup and teardown callbacks with typed context shared by reference across evals and cleanup. Setup returns the context directly before the local agent starts, and teardown runs after shutdown even when setup or the run fails.
