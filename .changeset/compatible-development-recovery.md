---
"eve": patch
---

Local development skips retained workflows whose framework build or authored workflow sources no longer match, rather than replaying them into corrupted-event-log errors. Incompatible runs and runs with malformed snapshot metadata remain stored without blocking recovery of compatible runs, and startup reports why recovery was skipped.
