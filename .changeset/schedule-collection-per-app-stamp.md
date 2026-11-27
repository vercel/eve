---
"eve": patch
---

Resolve a schedule collection into a per-application copy before stamping its source identity, so a schedule module shared by two agents in one process (for example `eve-hub/schedules/wake`) no longer fails with "source identity does not match its compiled module".
