---
"eve": minor
---

Add a finite `ClientSession.snapshot()` API for durable event reconciliation
and a public `SessionNotReadyError` auth contract that maps transient session
readiness to a stable, non-cacheable HTTP 425 response. Eve continuation
requests are now resume-only and bounded-retry readiness races instead of
silently starting a duplicate session.
