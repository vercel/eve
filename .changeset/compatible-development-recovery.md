---
"eve": patch
---

Local development skips retained workflows whose framework build or authored workflow sources no longer match, rather than replaying them into corrupted-event-log errors. Incompatible runs remain stored, and startup reports why recovery was skipped.
