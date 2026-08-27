---
"eve": patch
---

Preserve schedule provenance when a handler starts a session with user credentials. Scheduled background-task launches now stay silent instead of sending a launch acknowledgement, and schedule-created workflow runs expose `$eve.schedule` for attribution.
