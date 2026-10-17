---
"eve": patch
---

Reduce session handoff waits by validating idle state inside the workflow and registering coordination hooks together, while preserving inbox ownership and cleaning up partial registrations on failure. Keep the timer's recorded expiry when compaction moves a session to a new run, even if workflow start metadata changes during replay.
