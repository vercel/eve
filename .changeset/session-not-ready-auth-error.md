---
"eve": patch
---

Export `SessionNotReadyError` and `createReadinessResponse` from `eve/channels/auth` so route auth can return a typed, retryable `425` readiness failure.
